// Writes files.json: every lesson file with its size, for the offline download script.
// Run before each deploy:  node list-files.mjs && npx wrangler deploy
import { closeSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push([p.split('\\').join('/'), statSync(p).size]);
  }
})('LESSONS');
for (const name of readdirSync('SWF')) files.push(['SWF/' + name, statSync(join('SWF', name)).size]);
writeFileSync('files.json', JSON.stringify(files));
console.log(`files.json: ${files.length} files, ${(files.reduce((s, f) => s + f[1], 0) / 1e9).toFixed(2)} GB`);

// _headers: images, sounds, fonts and SWF files are cached for a day. Game code (html, js, wasm,
// data, unityweb, parts) keeps re-checking, so an updated game never mixes old and new files.
const MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'mp3', 'ogg', 'wav', 'm4a', 'woff', 'woff2', 'ttf', 'otf', 'swf'];
const lines = [];
for (const ext of MEDIA) lines.push(`/*.${ext}`, '  Cache-Control: public, max-age=86400');
writeFileSync('_headers', lines.join('\n') + '\n');

// packed.json: packed Unity files (gzip, or Unity's brotli). worker.js sends them as they are,
// marked with Content-Encoding, so the browser unpacks them natively instead of Unity's slow
// JavaScript fallback. Only whole files next to a Unity loader: split parts can't be unpacked on
// their own, and other engines unpack their own files.
const packedFiles = {};
const unityDirs = new Map();
const isUnityDir = (dir) => {
  if (!unityDirs.has(dir)) unityDirs.set(dir, readdirSync(dir).some((n) => n === 'UnityLoader.js' || n.endsWith('.loader.js')));
  return unityDirs.get(dir);
};
const head = (p) => { const b = Buffer.alloc(48); const fd = openSync(p, 'r'); readSync(fd, b, 0, 48, 0); closeSync(fd); return b; };
let packed = 0;
for (const [p] of files) {
  // Star-Drive-Lab is left as it is until its own update (user's call, 2026-11-24)
  if (!/\.(unityweb|gz|br)$/i.test(p) || p.startsWith('LESSONS/Star-Drive-Lab/') || !isUnityDir(dirname(p))) continue;
  const b = head(p);
  const enc = b[0] === 0x1f && b[1] === 0x8b ? 'gzip'
    : b.toString('latin1').includes('UnityWeb Compressed Content (brotli)') ? 'br' : '';
  if (!enc) continue;
  packedFiles['/' + p] = enc;
  packed++;
}
writeFileSync('packed.json', JSON.stringify(packedFiles, null, 1) + '\n');
console.log(`packed.json: ${packed} packed Unity files; _headers: ${MEDIA.length} cached media types`);
