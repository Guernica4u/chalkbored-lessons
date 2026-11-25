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
- `LESSONS/Night-Defense/ndnet.js`: sets `net_ice_broker` to this worker, the Co-op panel (top right: room code,
  games on this network, join by code, connection mode), and the relay switch.
- `patch-ftewebgl.mjs`: adds four one-line hooks to `ftewebgl.js` (WebRTC settings, new link, offer/answer, console
  lines). Rerun it after replacing `ftewebgl.js` with a new engine build. No engine rebuild needed.

## Connection modes (Co-op panel, saved per browser; `?net=auto|direct|relay` in the URL overrides)
- Auto: direct; if no direct link after 6 s (or it fails), the player switches to the relay. The host always
  accepts both.
- Direct only / Relay only.
Both ends name the relay link after the player's WebRTC offer (ICE username + password), so no extra messages.
ICE uses Cloudflare's public STUN server; there is no TURN server, the relay does that job.

## Run / test / deploy
- Local: `npx wrangler dev -c wrangler.toml --port 8797` here, the game with `npx wrangler dev --port 8798` in the
  repo root, then `http://localhost:8798/LESSONS/Night-Defense/?relay=ws://localhost:8797`.
- `node selftest.mjs ws://localhost:8797`: the worker on its own.
- `node browsertest.mjs <chrome.exe>`: host + players in headless Chromium (direct, relay only, Auto with direct
  blocked).
- Deploy: `npx wrangler deploy -c wrangler.toml` here. Address: wss://night-defense-relay.guernica4u.workers.dev
  (the default in `ndnet.js`). Join links: `.../Night-Defense/?join=CODE`.
