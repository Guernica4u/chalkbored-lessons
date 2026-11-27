// Night Defense co-op: points the engine at our broker (or the game's built-in one), and carries game packets over
// the relay when a direct (WebRTC) link can't be made. The game's own menus do the rest (tools/night-defense-relay/
// menu.patch): they read the nd_* cvars set here and print "ndnet ..." console lines that this reads.
// The engine calls ndNet.config/created/remote/print from four hooks in ftewebgl.js (see tools/night-defense-relay/README.md).
(function () {
  const q = new URLSearchParams(location.search);
  const base = (q.get("relay") || "wss://night-defense-relay.guernica4u.workers.dev").replace(/\/+$/, "");
  const httpBase = base.replace(/^ws/, "http");
  const BUILTIN_BROKER = "tls://master.frag-net.com:27950"; // the engine's default net_ice_broker
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const MODES = ["auto", "direct", "relay"];
  const join = (q.get("join") || "").toUpperCase();

  const ndNet = (window.ndNet = {
    mode: MODES.includes(q.get("net")) ? q.get("net") : MODES.includes(store.get("nd.netmode")) ? store.get("nd.netmode") : "auto",
    // a join link is always a ChalkBored room
    server: !join && store.get("nd.server") === "builtin" ? "builtin" : "chalkbored",
    timeoutMs: 6000, // a player without a direct link after this long switches to the relay (Auto)
    room: "",
    status: "",
    links: [],

    args() {
      // sv_port_rtc off: the Create Game menu's sv_public already opens the room (both would mean two room codes)
      const args = ["+set", "sv_port_rtc", "", "+set", "nd_broker", base, "+set", "nd_server", ndNet.server, "+set", "nd_mode", ndNet.mode,
        "+set", "net_ice_broker", ndNet.server === "builtin" ? BUILTIN_BROKER : base];
      if (/^[A-Z0-9_-]{1,32}$/.test(join)) args.push("+connect", "/" + join);
      return args;
    },

    // engine hook: every console line
    print(msg) {
      let m = /Listening on \S*\/([^/\s]+)\s*$/.exec(msg);
      if (m) { ndNet.room = m[1]; ndNet.links = []; cmd("set nd_room " + m[1]); return; }
      if (/Broker closing connection/.test(msg) && ndNet.room) { ndNet.room = ""; cmd('set nd_room ""'); }
      m = /^ndnet (server|mode) (\w+)$/.exec(msg);
      if (m && m[1] === "server" && (m[2] === "chalkbored" || m[2] === "builtin")) { ndNet.server = m[2]; store.set("nd.server", m[2]); }
      if (m && m[1] === "mode" && MODES.includes(m[2])) { ndNet.mode = m[2]; store.set("nd.netmode", m[2]); }
      if (msg === "ndnet lan") refreshLan();
    },

    // engine hook: the RTCPeerConnection settings (Cloudflare's public STUN server instead of the broker's host)
    config(cfg) {
      if (ndNet.server === "builtin") return cfg;
      cfg.iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
      return cfg;
    },

    // engine hook: a new link (s.isclient: we're the player; else we're the host and s is one player)
    created(s) {
      const dc = s.ws;
      const mode = (s.ndMode = ndNet.server === "builtin" ? "builtin" : s.isclient ? ndNet.mode : "auto");
      const dcOpen = dc.onopen;
      dc.onopen = (e) => { dcOpen(e); if (!s.ndRelay) linked(s, "direct"); };
      if (mode === "builtin") return; // the relay is ours, so only for the ChalkBored server
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
      if (s.ndMode === "builtin") return false;
      if (s.isclient) return s.ndMode === "relay" || !!s.ndRelay; // Relay only: no direct link at all
      if (!s.broker) keyOf(text).then((key) => { if (s.callcb && !s.broker) openRelay(s, key, "h"); });
      return false;
    },
  });

  // a console command (FTEC.cbufadd queues it, then throws: this build has no _free)
  function cmd(text) {
    try { FTEC.cbufadd(text + "\n"); } catch {}
  }

  // the game's Network Games screen: nd_lan = "CODE~label|CODE~label|..."
  async function refreshLan() {
    if (ndNet.server === "builtin") return;
    let games;
    try {
      games = (await (await fetch(httpBase + "/lan", { cache: "no-store" })).json()).games || [];
    } catch {
      return cmd('set nd_lan ""; set nd_lanstatus "Cannot reach the ChalkBored server."');
    }
    const clean = (t) => String(t).replace(/[^A-Za-z0-9 ._()/-]/g, "").slice(0, 30);
    const list = games.filter((g) => g.code !== ndNet.room).slice(0, 6)
      .map((g) => clean(g.code) + "~" + clean(`${g.map || "?"}  ${g.players}${g.max ? "/" + g.max : ""} player${g.players === 1 && !g.max ? "" : "s"}`));
    cmd(`set nd_lan "${list.join("|")}"; set nd_lanstatus "${list.length ? "" : "No games on your network yet."}"`);
  }

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

  // ndNet.status / ndNet.links: for tests (browsertest.mjs) and the browser console
  function linked(s, how) {
    if (!s.isclient) return ndNet.links.push(how);
    ndNet.status = how === "relay" ? "Connecting through the relay..." : "Connected to the host (direct).";
    if (how !== "relay") return;
    const ws = s.ws;
    const check = setInterval(() => {
      if (s.ws !== ws || !s.callcb) return clearInterval(check);
      if (s.inq.length || s.con) { ndNet.status = "Connected to the host (relay)."; clearInterval(check); }
    }, 500);
  }
})();
