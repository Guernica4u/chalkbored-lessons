// Night Defense co-op: points the engine at our broker, carries game packets over the relay when a direct
// (WebRTC) link can't be made, and shows a small Co-op panel (room code, games on this network, join by code).
// The engine calls ndNet.config/created/remote/print from four hooks in ftewebgl.js (see tools/night-defense-relay/README.md).
(function () {
  const q = new URLSearchParams(location.search);
  const base = (q.get("relay") || "wss://night-defense-relay.guernica4u.workers.dev").replace(/\/+$/, "");
  const httpBase = base.replace(/^ws/, "http");
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const MODES = { auto: "Auto (direct, relay if blocked)", direct: "Direct only", relay: "Relay only" };

  const ndNet = (window.ndNet = {
    mode: MODES[q.get("net")] ? q.get("net") : MODES[store.get("nd.netmode")] ? store.get("nd.netmode") : "auto",
    timeoutMs: 6000, // a player without a direct link after this long switches to the relay (Auto)
    room: "",
    status: "",
    links: [],

    args() {
      const args = ["+set", "net_ice_broker", base];
      const join = (q.get("join") || "").toUpperCase();
      if (/^[A-Z0-9_-]{1,32}$/.test(join)) args.push("+connect", "/" + join);
      return args;
    },

    print(msg) {
      let m = /Listening on \S*\/([^/\s]+)\s*$/.exec(msg);
      if (m) { ndNet.room = m[1]; ndNet.links = []; render(); return; }
      m = /Broker closing connection: (.*)/.exec(msg);
      if (m) { ndNet.status = m[1]; render(); }
    },

    // engine hook: the RTCPeerConnection settings (Cloudflare's public STUN server instead of the broker's host)
    config(cfg) {
      cfg.iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
      return cfg;
    },

    // engine hook: a new link (s.isclient: we're the player; else we're the host and s is one player)
    created(s) {
      const dc = s.ws;
      const mode = (s.ndMode = s.isclient ? ndNet.mode : "auto");
      const dcOpen = dc.onopen;
      dc.onopen = (e) => { dcOpen(e); if (!s.ndRelay) linked(s, "direct"); };
      // a failed direct link is only an error when the relay can't take over
      const fail = () => {
        if (s.ndRelay) return;
        if (s.isclient && !s.con && mode === "auto" && s.ndKey) useRelay(s);
        else if (s.isclient ? mode === "direct" || s.con : !s.broker || s.con) { s.con = 0; s.err = 1; }
      };
      dc.onclose = fail;
      s.pc.onconnectionstatechange = () => {
        if (s.pc && ["failed", "disconnected", "closed"].includes(s.pc.connectionState)) fail();
      };
      if (!s.isclient) return;
      const cb = s.callcb;
      s.callcb = (type, text) => {
        try { cb(type, text); } catch {} // the engine's callback throws after its work: this build has no _free
        if (type !== 3 || s.ndKey) return; // 3 = our offer
        keyOf(text).then((key) => {
          s.ndKey = key;
          if (!s.callcb) return; // closed meanwhile
          if (mode === "relay") useRelay(s);
          else if (mode === "auto") setTimeout(() => { if (s.callcb && !s.con && !s.ndRelay) useRelay(s); }, ndNet.timeoutMs);
        });
      };
    },

    // engine hook: the other side's offer (host) or answer (player). true = skip it.
    remote(s, text) {
      if (s.isclient) return s.ndMode === "relay" || !!s.ndRelay; // Relay only: no direct link at all
      if (!s.broker) keyOf(text).then((key) => { if (s.callcb && !s.broker) openRelay(s, key, "h"); });
      return false;
    },
  });

  // both ends name their relay link after the player's offer (its ICE username + password)
  async function keyOf(text) {
    let sdp = text;
    try { sdp = JSON.parse(text).sdp || text; } catch {}
    const ufrag = (/a=ice-ufrag:(\S+)/.exec(sdp) || [])[1] || "";
    const pwd = (/a=ice-pwd:(\S+)/.exec(sdp) || [])[1] || "";
    const bytes = new TextEncoder().encode(ufrag + ":" + pwd);
    const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    // crypto.subtle needs https or localhost; a plain-http LAN address uses the text itself
    if (window.crypto && crypto.subtle) return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).slice(0, 32);
    return hex(bytes).slice(0, 64);
  }

  function openRelay(s, key, role) {
    const ws = new WebSocket(`${base}/relay/${key}?role=${role}`);
    ws.binaryType = "arraybuffer";
    s.broker = ws; // the engine's ws_close closes s.broker too
    ws.onmessage = (e) => {
      if (s.ws !== ws) switchTo(s, ws); // host: this player came over the relay
      s.inq.push(new Uint8Array(e.data));
    };
    ws.onclose = () => { if (s.ws === ws) { s.con = 0; s.err = 1; } };
    return ws;
  }

  function switchTo(s, ws) {
    const dc = s.ws;
    if (dc) dc.onopen = dc.onclose = dc.onmessage = null;
    if (s.recvchan) s.recvchan.onmessage = null;
    if (s.pc) { s.pc.onconnectionstatechange = null; try { s.pc.close(); } catch {} }
    s.pc = null;
    s.ndRelay = true;
    s.ws = ws;
    s.con = ws.readyState === WebSocket.OPEN ? 1 : 0;
    s.err = 0;
    linked(s, "relay");
  }

  function useRelay(s) {
    const ws = openRelay(s, s.ndKey, "c");
    switchTo(s, ws);
    ws.onopen = () => { if (s.ws === ws) s.con = 1; };
  }

  function linked(s, how) {
    if (s.isclient) ndNet.status = how === "relay" ? "Connecting through the relay..." : "Connected to the host (direct).";
    else ndNet.links.push(how);
    if (s.isclient && how === "relay") {
      const ws = s.ws;
      const check = setInterval(() => {
        if (s.ws !== ws || !s.callcb) return clearInterval(check);
        if (s.inq.length || s.con) { ndNet.status = "Connected to the host (relay)."; render(); clearInterval(check); }
      }, 500);
    }
    render();
  }

  // ---- the Co-op panel
  let panel, lanTimer;
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, attrs);
    e.append(...kids);
    return e;
  }

  function join(code) {
    code = String(code || "").trim().replace(/^\//, "").toUpperCase();
    if (!/^[A-Z0-9_-]{1,32}$/.test(code) || !window.FTEC) return;
    ndNet.status = "Joining " + code + "...";
    try { FTEC.cbufadd("connect /" + code + "\n"); } catch {} // queues the command, then throws (no _free)
    render();
  }

  async function refreshLan() {
    try {
      const r = await fetch(httpBase + "/lan", { cache: "no-store" });
      ndNet.lan = (await r.json()).games || [];
    } catch { ndNet.lan = null; }
    render();
  }

  function render() {
    if (!panel || panel.hidden) return;
    const body = panel.querySelector(".nd-body");
    body.replaceChildren();
    const select = el("select", { onchange: () => { ndNet.mode = select.value; store.set("nd.netmode", select.value); } });
    for (const k in MODES) select.append(el("option", { value: k, textContent: MODES[k], selected: k === ndNet.mode }));
    body.append(el("label", {}, "Connection: ", select));

    if (ndNet.room) {
      const players = ndNet.links.length ? ` Players joined: ${ndNet.links.length} (${ndNet.links.join(", ")}).` : "";
      body.append(el("p", {}, "Hosting. Room code: ", el("b", { textContent: ndNet.room }), `. Others pick it below, or type /${ndNet.room} in Co-op > Join Game > Direct IP/ID.${players}`));
    } else {
      body.append(el("p", { textContent: "To host: Co-op > Create Game in the game menu. Your room code shows up here." }));
    }

    body.append(el("p", { className: "nd-h", textContent: "Games on your network" }));
    if (ndNet.lan == null) body.append(el("p", { textContent: "Can't reach the co-op server." }));
    else if (!ndNet.lan.length) body.append(el("p", { textContent: "None yet." }));
    else for (const g of ndNet.lan) {
      if (g.code === ndNet.room) continue;
      const info = `${g.name} (${g.code})` + (g.max ? ` ${g.players}/${g.max}` : "") + (g.map ? ` ${g.map}` : "");
      body.append(el("div", { className: "nd-row" }, el("span", { textContent: info }), el("button", { textContent: "Join", onclick: () => join(g.code) })));
    }

    const input = el("input", { placeholder: "Room code", maxLength: 32, size: 10, onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") join(input.value); } });
    body.append(el("div", { className: "nd-row" }, input, el("button", { textContent: "Join", onclick: () => join(input.value) })));
    if (ndNet.status) body.append(el("p", { textContent: ndNet.status }));
  }

  function setupPanel() {
    const style = el("style", { textContent:
      "#nd-coop{position:fixed;top:8px;right:8px;z-index:10;font:13px sans-serif;color:#ddd;text-align:left}" +
      "#nd-coop>button{opacity:.6}#nd-coop>button:hover{opacity:1}" +
      "#nd-coop .nd-panel{margin-top:4px;width:280px;max-width:calc(100vw - 32px);background:rgba(0,0,0,.85);border:1px solid #555;padding:8px}" +
      "#nd-coop p{margin:6px 0}#nd-coop .nd-h{font-weight:bold}#nd-coop .nd-row{display:flex;gap:6px;justify-content:space-between;align-items:center;margin:4px 0}" +
      "#nd-coop button,#nd-coop select,#nd-coop input{font:inherit}" });
    panel = el("div", { className: "nd-panel", hidden: true }, el("div", { className: "nd-body" }));
    const toggle = el("button", { textContent: "Co-op", onclick: () => {
      panel.hidden = !panel.hidden;
      clearInterval(lanTimer);
      if (!panel.hidden) { refreshLan(); lanTimer = setInterval(refreshLan, 5000); }
      render();
    } });
    document.head.append(style);
    document.body.append(el("div", { id: "nd-coop" }, toggle, panel));
  }
  if (document.body) setupPanel();
  else document.addEventListener("DOMContentLoaded", setupPanel);
})();
