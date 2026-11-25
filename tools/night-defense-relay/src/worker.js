// Night Defense co-op server for Cloudflare Workers (free plan). Three jobs, one Durable Object class:
//
// 1. Broker: the WebRTC matchmaking protocol the FTE engine already speaks (net_ice_broker, see
//    engine/common/net_wins.c in FTE: FTENET_TCP_WebRTCServerAssigned and the TCPC_WEBRTC_* code).
//    Host:   WebSocket  /<protocol>/            subprotocol "rtc_host"   -> gets a 5-letter room code
//    Player: WebSocket  /<protocol>/<CODE>      subprotocol "rtc_client"
//    Messages are binary: [type, clientnum lo, clientnum hi, text...]; the broker only passes the WebRTC
//    offers/candidates between a room's host and its players, rewriting the client number.
// 2. Relay: WebSocket /relay/<key>?role=h|c (no subprotocol). For networks that block direct browser
//    links: the page's patch in ftewebgl.js (index.html, ndNet) sends the game packets here instead.
//    <key> is a hash of the player's WebRTC offer, which only the two ends and the broker have seen.
// 3. LAN list: GET /lan lists the rooms hosted from the caller's network (same public IP; IPv6: same /64).
//
//   npx wrangler dev      run it on this PC (http://localhost:8787)
//   npx wrangler deploy   put it on Cloudflare
import { DurableObject } from "cloudflare:workers";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const MAX_MESSAGE = 65536;
const LAN_ENTRY_MAX_MS = 12 * 3600 * 1000; // a LAN entry whose room never said goodbye is dropped after this

// FTE's ICEMSG_* (engine/common/netinc.h)
const PEERLOST = 0, GREETING = 1, NEWPEER = 2, SERVERINFO = 6, NAMEINUSE = 8;

function newCode() {
  let code = "";
  for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

// [type, cl lo, cl hi, each text + \0]
function iceMessage(type, cl, ...texts) {
  const body = new TextEncoder().encode(texts.map((t) => t + "\0").join(""));
  const out = new Uint8Array(3 + body.length);
  out[0] = type;
  out[1] = cl & 0xff;
  out[2] = (cl >> 8) & 0xff;
  out.set(body, 3);
  return out;
}

function networkOf(request) {
  let ip = request.headers.get("CF-Connecting-IP") || "local";
  if (ip.includes(":")) ip = ip.split(":").slice(0, 4).join(":");
  return ip;
}

function stub(env, name) {
  return env.ROOMS.get(env.ROOMS.idFromName(name));
}

function forward(env, name, request, kind, extra = {}) {
  const headers = new Headers(request.headers);
  headers.set("X-ND-Kind", kind);
  headers.set("X-ND-Network", networkOf(request));
  for (const k in extra) headers.set(k, extra[k]);
  return stub(env, name).fetch(request.url, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/lan") {
      const response = await stub(env, "lan:" + networkOf(request)).fetch("https://lan/", { headers: { "X-ND-Kind": "lan-list" } });
      return new Response(response.body, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Night Defense co-op server\n", { headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" } });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const sub = request.headers.get("Sec-WebSocket-Protocol") || "";

    if (!sub && parts[0] === "relay" && /^[0-9a-f]{16,64}$/.test(parts[1] || "")) {
      const role = url.searchParams.get("role");
      if (role !== "h" && role !== "c") return new Response("bad role", { status: 400 });
      return forward(env, "relay:" + parts[1], request, "relay", { "X-ND-Role": role });
    }

    const proto = parts[0] || "";
    const name = (parts[1] || "").toUpperCase();
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(proto) || (name && !/^[A-Z0-9_-]{1,32}$/.test(name)) || parts.length > 2) {
      return new Response("bad path", { status: 400 });
    }
    if (sub === "rtc_host") {
      if (name) return forward(env, "room:" + name, request, "host", { "X-ND-Code": name, "X-ND-Proto": proto, "X-ND-Fixed": "1" });
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = newCode();
        const response = await forward(env, "room:" + code, request, "host", { "X-ND-Code": code, "X-ND-Proto": proto });
        if (response.status !== 409) return response;
      }
      return new Response("no free room", { status: 503 });
    }
    if (sub === "rtc_client" && name) return forward(env, "room:" + name, request, "client", { "X-ND-Code": name });
    return new Response("unknown connection type", { status: 400 });
  },
};

// Uses the hibernation WebSocket API: per-socket details live in the socket attachments.
export class Room extends DurableObject {
  async fetch(request) {
    const kind = request.headers.get("X-ND-Kind");
    if (kind === "lan-list" || kind === "lan-update") return this.lan(request, kind);
    if (kind === "relay") return this.relayJoin(request.headers.get("X-ND-Role"));

    const code = request.headers.get("X-ND-Code");
    const pair = new WebSocketPair();
    const accept = (subprotocol) => new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": subprotocol } });

    if (kind === "host") {
      if (this.host()) {
        if (!request.headers.get("X-ND-Fixed")) return new Response("taken", { status: 409 });
        pair[1].accept();
        pair[1].send(iceMessage(NAMEINUSE, -1, code));
        pair[1].close(4000, "name in use");
        return accept("rtc_host");
      }
      const proto = request.headers.get("X-ND-Proto");
      const network = request.headers.get("X-ND-Network");
      this.ctx.acceptWebSocket(pair[1], ["host"]);
      pair[1].serializeAttachment({ kind: "host", code, network, lan: "" });
      pair[1].send(iceMessage(GREETING, -1, proto + "/" + code));
      for (const client of this.open("client")) this.introduce(pair[1], client);
      await this.lanUpdate(network, { add: code, info: { name: "Night Defense", players: 0, max: 0, map: "" } });
      return accept("rtc_host");
    }

    // a player: numbered from 0, the smallest free number
    const used = new Set(this.open("client").map((s) => s.deserializeAttachment().num));
    let num = 0;
    while (used.has(num)) num++;
    this.ctx.acceptWebSocket(pair[1], ["client", "c" + num]);
    pair[1].serializeAttachment({ kind: "client", num });
    const host = this.host();
    if (host) this.introduce(host, pair[1]);
    else {
      pair[1].send(iceMessage(PEERLOST, -1, `No game with code ${code} was found.`));
      pair[1].close(4000, "no such game");
    }
    return accept("rtc_client");
  }

  introduce(host, client) {
    const num = client.deserializeAttachment().num;
    host.send(iceMessage(NEWPEER, num, "", ""));
    client.send(iceMessage(NEWPEER, -1, "", ""));
  }

  async webSocketMessage(socket, data) {
    if (typeof data === "string" || data.byteLength > MAX_MESSAGE) return;
    const info = socket.deserializeAttachment();
    if (info.kind === "relay") {
      for (const other of this.open(info.role === "h" ? "c" : "h")) other.send(data);
      return;
    }
    const bytes = new Uint8Array(data);
    if (bytes.length < 3) return;
    if (info.kind === "host") {
      if (bytes[0] === SERVERINFO) return this.serverInfo(socket, info, bytes);
      const target = this.open("c" + (bytes[1] | (bytes[2] << 8)))[0];
      bytes[1] = bytes[2] = 0xff;
      if (target) target.send(bytes);
      return;
    }
    const host = this.host();
    bytes[1] = info.num & 0xff;
    bytes[2] = info.num >> 8;
    if (host) host.send(bytes);
  }

  // the host's serverinfo ("\key\value..."): kept for the LAN list
  async serverInfo(socket, info, bytes) {
    const text = new TextDecoder().decode(bytes.subarray(3)).split("\0")[0];
    const kv = text.split("\\").slice(1);
    const get = (key) => { const i = kv.indexOf(key); return i >= 0 && i % 2 === 0 ? kv[i + 1] || "" : ""; };
    const entry = {
      name: get("hostname").slice(0, 40) || "Night Defense",
      players: Number(get("clients")) || 0,
      max: Number(get("sv_maxclients")) || 0,
      map: get("mapname").slice(0, 40),
    };
    const key = JSON.stringify(entry);
    if (key === info.lan) return;
    info.lan = key;
    socket.serializeAttachment(info);
    await this.lanUpdate(info.network, { add: info.code, info: entry });
  }

  async webSocketClose(socket) {
    const info = socket.deserializeAttachment();
    if (!info || info.gone) return;
    info.gone = true;
    socket.serializeAttachment(info);
    if (info.kind === "relay") {
      for (const other of this.open(info.role === "h" ? "c" : "h")) try { other.close(4000, "peer left"); } catch {}
    } else if (info.kind === "client") {
      const host = this.host();
      if (host) host.send(iceMessage(PEERLOST, info.num, "left"));
    } else if (info.kind === "host") {
      for (const client of this.open("client")) {
        try { client.send(iceMessage(PEERLOST, -1, "The host left the game.")); client.close(4000, "host left"); } catch {}
      }
      await this.lanUpdate(info.network, { remove: info.code });
    }
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }

  // ---- relay (objects named "relay:<key>"): one host end (h) and one player end (c), packets passed both ways
  relayJoin(role) {
    for (const old of this.open(role)) {
      old.serializeAttachment({ ...old.deserializeAttachment(), gone: true });
      try { old.close(4001, "replaced"); } catch {}
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ kind: "relay", role });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---- LAN list (objects named "lan:<network>")
  async lan(request, kind) {
    const games = (await this.ctx.storage.get("games")) || {};
    const now = Date.now();
    for (const code in games) if (now - games[code].time > LAN_ENTRY_MAX_MS) delete games[code];
    if (kind === "lan-update") {
      const change = await request.json();
      if (change.add) games[change.add] = { ...change.info, time: now };
      if (change.remove) delete games[change.remove];
      await this.ctx.storage.put("games", games);
      return new Response("ok");
    }
    return new Response(JSON.stringify({ games: Object.keys(games).map((code) => ({ code, ...games[code], time: undefined })) }));
  }

  async lanUpdate(network, change) {
    try {
      await stub(this.env, "lan:" + network).fetch("https://lan/", { method: "POST", headers: { "X-ND-Kind": "lan-update" }, body: JSON.stringify(change) });
    } catch (error) {
      console.log("LAN list update failed: " + error);
    }
  }

  open(tag) {
    return this.ctx.getWebSockets(tag).filter((s) => s.readyState === WebSocket.OPEN && !(s.deserializeAttachment() || {}).gone);
  }

  host() {
    return this.open("host")[0] || null;
  }
}
