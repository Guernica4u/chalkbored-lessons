// Checks the co-op server on its own:  node selftest.mjs [ws://localhost:8787]   (needs Node 22+, `npx wrangler dev` running)
import assert from 'node:assert/strict';

const base = process.argv[2] || 'ws://localhost:8787';
const open = (path, proto) => new Promise((resolve, reject) => {
  const ws = new WebSocket(base + path, proto);
  ws.binaryType = 'arraybuffer';
  ws.inbox = [];
  ws.waiters = [];
  ws.onmessage = (e) => { const w = ws.waiters.shift(); w ? w(new Uint8Array(e.data)) : ws.inbox.push(new Uint8Array(e.data)); };
  ws.onopen = () => resolve(ws);
  ws.onerror = reject;
});
const next = (ws) => new Promise((resolve, reject) => {
  if (ws.inbox.length) return resolve(ws.inbox.shift());
  const t = setTimeout(() => reject(new Error('timeout')), 3000);
  ws.waiters.push((m) => { clearTimeout(t); resolve(m); });
});
const text = (m) => new TextDecoder().decode(m.subarray(3)).split('\0');
const cl = (m) => m[1] | (m[2] << 8);
const msg = (type, n, s) => new Uint8Array([type, n & 0xff, (n >> 8) & 0xff, ...new TextEncoder().encode(s)]);

const host = await open('/NZP/', 'rtc_host');
assert.equal(host.protocol, 'rtc_host');
let m = await next(host);
assert.equal(m[0], 1); // GREETING
const code = text(m)[0].split('/')[1];
assert.match(code, /^[A-Z0-9]{5}$/);

const player = await open('/NZP/' + code.toLowerCase(), 'rtc_client');
m = await next(host); assert.deepEqual([m[0], cl(m)], [2, 0]); // NEWPEER for player 0
m = await next(player); assert.deepEqual([m[0], cl(m)], [2, 0xffff]);

player.send(msg(3, 0xffff, '{"type":"offer"}'));
m = await next(host); assert.deepEqual([m[0], cl(m), text(m)[0]], [3, 0, '{"type":"offer"}']);
host.send(msg(4, 0, 'cand'));
m = await next(player); assert.deepEqual([m[0], cl(m), text(m)[0]], [4, 0xffff, 'cand']);

host.send(msg(6, -1, '\\hostname\\Test room\\clients\\1\\sv_maxclients\\4\\mapname\\ndu\0'));
await new Promise((r) => setTimeout(r, 300));
const lan = await (await fetch(base.replace(/^ws/, 'http') + '/lan')).json();
assert.ok(lan.games.some((g) => g.code === code && g.name === 'Test room' && g.max === 4), JSON.stringify(lan));

const missing = await open('/NZP/ZZZZZ', 'rtc_client');
m = await next(missing); assert.deepEqual([m[0], cl(m)], [0, 0xffff]); // PEERLOST: no such game

const key = 'ab'.repeat(16);
const rh = await open(`/relay/${key}?role=h`);
const rc = await open(`/relay/${key}?role=c`);
rc.send(new Uint8Array([1, 2, 3]));
assert.deepEqual([...await next(rh)], [1, 2, 3]);
rh.send(new Uint8Array([4, 5]));
assert.deepEqual([...await next(rc)], [4, 5]);

player.close();
m = await next(host); assert.deepEqual([m[0], cl(m)], [0, 0]); // PEERLOST for player 0
host.close();
await new Promise((r) => setTimeout(r, 300));
const after = await (await fetch(base.replace(/^ws/, 'http') + '/lan')).json();
assert.ok(!after.games.some((g) => g.code === code), 'room still listed after the host left');
for (const ws of [rh, rc, missing]) ws.close();
console.log('selftest ok, room ' + code);
