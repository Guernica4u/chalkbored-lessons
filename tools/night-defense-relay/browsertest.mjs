// Two-tab co-op test in headless Chromium: a host tab starts a game, player tabs join it direct, relay-only,
// and on Auto with direct links blocked (must fall back to the relay). Needs the game served (repo root:
// `npx wrangler dev --port 8798`) and this relay (`npx wrangler dev -c wrangler.toml --port 8797`).
//   node browsertest.mjs <chrome.exe> [game page url] [relay ws url]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [chromePath, page = 'http://localhost:8798/LESSONS/Night-Defense/', relay = 'ws://localhost:8797', only = ''] = process.argv.slice(2);
const port = 9333;
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ndtest-'))}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab(url, name) {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value).join(' '));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Page.navigate', { url }); // not via /json/new: its query string would eat the page's own '&' parameters
  // runs an async expression in the page until it returns something truthy
  const until = async (expr, seconds, what) => {
    for (let i = 0; i < seconds * 2; i++) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.result?.value) return r.result.result.value;
      await sleep(500);
    }
    throw new Error(`${name}: timed out waiting for ${what}\n  last log: ${logs.slice(-8).join('\n  ')}`);
  };
  return { send, until, logs, close: () => fetch(`http://127.0.0.1:${port}/json/close/${t.id}`) };
}

const results = [];
try {
  const host = await tab(`${page}?relay=${relay}`, 'host');
  await host.until('!!(window.FTEC && FTEC.evcb && FTEC.evcb.cbufaddtext)', 120, 'engine start');
  await sleep(3000);
  await host.until('(()=>{try{FTEC.cbufadd("set maxclients 4\\nset god 1\\nmap ndu\\n")}catch{}return 1})()', 5, 'map command');
  const room = await host.until('ndNet.room', 180, 'room code');
  console.log('host room', room);

  for (const [label, mode, blockDirect] of [['direct', 'direct', false], ['relay only', 'relay', false], ['auto, direct blocked', 'auto', true]]) {
    if (only && !only.split(',').includes(mode)) continue;
    const joinedBefore = host.logs.filter((l) => /has joined the game/.test(l)).length;
    const player = await tab(`${page}?relay=${relay}&net=${mode}`, label);
    await player.until('!!(window.FTEC && FTEC.evcb && FTEC.evcb.cbufaddtext)', 120, 'engine start');
    await sleep(2000);
    // blocked direct links: no ICE candidates at all, like a network that drops browser-to-browser traffic
    if (blockDirect) await player.until('(ndNet.config=(c)=>({...c,iceServers:[],iceTransportPolicy:"relay"}),1)', 5, 'block');
    await player.until(`(()=>{try{FTEC.cbufadd("connect /${room}\\n")}catch{}return 1})()`, 5, 'connect');
    const status = await player.until('/Connected/.test(ndNet.status) && ndNet.status', 120, 'link');
    await sleep(1000);
    for (let i = 0; i < 240 && host.logs.filter((l) => /has joined the game/.test(l)).length <= joinedBefore; i++) await sleep(500);
    const joined = host.logs.filter((l) => /has joined the game/.test(l)).length > joinedBefore;
    const links = await host.until('JSON.stringify(ndNet.links)', 5, 'links');
    results.push(`${label}: player says "${status}", host sees join: ${joined}, host links ${links}`);
    console.log(results.at(-1));
    await player.close();
    await sleep(3000);
  }
  const lan = await (await fetch(relay.replace(/^ws/, 'http') + '/lan')).json();
  console.log('LAN list', JSON.stringify(lan));
} finally {
  chrome.kill();
}
