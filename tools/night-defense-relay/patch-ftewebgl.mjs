// Adds the three ndNet hooks (LESSONS/Night-Defense/ndnet.js) to FTE's WebRTC code in ftewebgl.js.
// Run again after replacing ftewebgl.js with a new engine build:  node tools/night-defense-relay/patch-ftewebgl.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../../LESSONS/Night-Defense/ftewebgl.js', import.meta.url);
let js = readFileSync(file, 'utf8');
const hooks = [
  // the RTCPeerConnection settings
  ['pcconfig=JSON.parse(UTF8ToString(pcconfig))}catch(err){pcconfig={}}', 'if(window.ndNet)pcconfig=ndNet.config(pcconfig);'],
  // a new link, before the engine gets its handle
  ['return _emscriptenfte_handle_alloc(s)}function _emscriptenfte_rtc_offer(', 'if(window.ndNet)ndNet.created(s);', true],
  // the other side's offer/answer
  ['offertype=UTF8ToString(offertype);if(s===undefined)return-1;', 'if(window.ndNet&&ndNet.remote(s,offer))return 0;'],
  // console lines (the host's room code is in "Listening on ...")
  ['console.log(FTEC.linebuffer.substring(0,nl));', 'if(window.ndNet)ndNet.print(FTEC.linebuffer.substring(0,nl));'],
];
for (const [at, add, before] of hooks) {
  if (js.includes(before ? add + at : at + add)) continue;
  if (js.split(at).length !== 2) throw new Error('hook point not found exactly once: ' + at);
  js = js.replace(at, before ? add + at : at + add);
}
writeFileSync(file, js);
console.log('ftewebgl.js: ndNet hooks in place');
