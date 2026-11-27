# Night Defense co-op

Co-op for `LESSONS/Night-Defense/` (FTE engine, WebGL build). The game already has a Co-op menu (Create Game,
Join Game > Direct IP/ID) that uses FTE's WebRTC "broker": a small server that introduces the host's browser to the
players' browsers, after which game packets go browser to browser. This folder is our own broker, plus a relay for
networks that block browser-to-browser traffic. Not served by the lessons site (`tools` is in `.assetsignore`).

## Pieces
- `src/worker.js`: Cloudflare Worker `night-defense-relay` (free plan, one Durable Object class).
  - Broker: FTE's protocol (FTE source `engine/common/net_wins.c`, the `TCPC_WEBRTC_*` code; checked against
    github.com/nzp-team/fteqw at 2025-09-23). A host gets a 5-character room code.
  - Relay: `/relay/<key>?role=h|c`, passes game packets between one host and one player.
  - LAN list: `GET /lan`, rooms hosted from the caller's public address (IPv6: same /64).
- `LESSONS/Night-Defense/ndnet.js`: points the engine at the chosen broker (sets `net_ice_broker`), the relay
  switch, and the bridge to the game's menus: it sets `nd_*` cvars (`nd_room`, `nd_lan`, `nd_mode`, `nd_server`)
  and reads the `ndnet ...` console lines the menus print.
- `patch-ftewebgl.mjs`: adds four one-line hooks to `ftewebgl.js` (WebRTC settings, new link, offer/answer, console
  lines). Rerun it after replacing `ftewebgl.js` with a new engine build. No engine rebuild needed.
- `menu.patch`: the game's own menus (nzp-team/quakec at 7ab55bf, the commit the shipped progs.pk3 was built from):
  COOPERATIVE opens CHOOSE SERVER (ChalkBored server, "works at school", or the built-in public server); the Co-op
  menu gets a CONNECTION setting; Join Game gets NETWORK GAMES and ENTER ROOM CODE; the pause menu shows the room
  code while hosting. `build-progs.mjs` compiles it with fteqcc (FTE's QuakeC compiler) and updates
  `nzp/progs.pk3` (menu.dat, csprogs.dat; qwprogs.dat untouched). fteqcc crashes without a message when a function
  is called before it's declared, so declare new screens in `defs/menu_defs.qc`.

## Connection modes (in-game: Co-op > CONNECTION, saved per browser; `?net=auto|direct|relay` in the URL overrides)
- Auto: direct; if no direct link after 6 s (or it fails), the player switches to the relay. The host always
  accepts both.
- Direct only / Relay only.
- The built-in server has no relay (the relay is ours).
Both ends name the relay link after the player's WebRTC offer (ICE username + password), so no extra messages.
ICE uses Cloudflare's public STUN server; there is no TURN server, the relay does that job.
`sv_port_rtc` is set empty, so only the Create Game menu's `sv_public` opens a room (otherwise a host gets two codes).

## Run / test / deploy
- Local: `npx wrangler dev -c wrangler.toml --port 8797` here, the game with `npx wrangler dev --port 8798` in the
  repo root, then `http://localhost:8798/LESSONS/Night-Defense/?relay=ws://localhost:8797`.
- `node selftest.mjs ws://localhost:8797`: the worker on its own.
- `node browsertest.mjs <chrome.exe>`: host + players in headless Chromium (direct, relay only, Auto with direct
  blocked).
- `node browsertest.mjs` uses console commands; the menus were checked by keyboard in headless Chromium (mouse
  clicks don't reach the game there).
- Deploy: `npx wrangler deploy -c wrangler.toml` here. Address: wss://night-defense-relay.guernica4u.workers.dev
  (the default in `ndnet.js`). Join links: `.../Night-Defense/?join=CODE`.
