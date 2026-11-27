// Rebuilds the game's menu (menu.dat) and in-game code (csprogs.dat, for the pause menu's room code) with our
// co-op screens, and puts them into LESSONS/Night-Defense/nzp/progs.pk3 (qwprogs.dat is kept as it is).
//   1. git clone https://github.com/nzp-team/quakec <dir> && git -C <dir> checkout 7ab55bf   (the shipped build)
//   2. git -C <dir> apply tools/night-defense-relay/menu.patch
//   3. node build-progs.mjs <fteqcc64.exe> <dir>   (fteqcc64.exe: in fteqw-win64-*.zip, github.com/fte-team/fteqw releases)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

const [fteqcc, qcDir] = process.argv.slice(2);
const pk3Path = new URL('../../LESSONS/Night-Defense/nzp/progs.pk3', import.meta.url);

// flags as in the project's tools/qc-compiler-gnu.sh
mkdirSync(join(qcDir, 'build/fte'), { recursive: true });
for (const [src, flags] of [['menu', ['-O3', '-DFTE', '-Wall']], ['csqc', ['-DFTE', '-Wall']]]) {
  // fteqcc crashes (no message) on a call to a function that isn't declared yet
  const r = spawnSync(fteqcc, [...flags, '-srcfile', `progs/${src}.src`], { cwd: qcDir, encoding: 'utf8' });
  const log = r.stdout + r.stderr;
  if (r.status !== 0 || !/Done\./.test(log) || /\berror\b/i.test(log)) throw new Error(`${src} failed (exit ${r.status}):\n${log}`);
}
const built = Object.fromEntries(['menu.dat', 'csprogs.dat', 'csprogs.lno'].map((n) => [n, readFileSync(join(qcDir, 'build/fte', n))]));

// read the pk3's entries (stored or deflated)
function unzip(buf) {
  const entries = [];
  let p = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const count = buf.readUInt16LE(p + 10);
  p = buf.readUInt32LE(p + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen), lo = buf.readUInt32LE(p + 42);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + csize);
    entries.push([name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw)]);
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

// write a zip (stored, no compression; the engine reads either)
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(10, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(local, n, data); central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

const entries = unzip(readFileSync(pk3Path)).map(([n, d]) => [n, built[n] || d]);
const again = unzip(zip(entries));
for (const [n, d] of entries) if (!again.find(([m, e]) => m === n && e.equals(d))) throw new Error('zip round trip failed: ' + n);
writeFileSync(pk3Path, zip(entries));
console.log('progs.pk3: ' + entries.map(([n, d]) => `${n} ${d.length}`).join(', '));
