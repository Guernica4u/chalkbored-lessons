// Runs only for .unityweb, .br and .gz files (run_worker_first in wrangler.jsonc); everything else is
// served straight from the static files. Packed Unity files (listed in packed.json by
// list-files.mjs) go out byte for byte with Content-Encoding, so the browser unpacks them natively
// instead of Unity's slow JavaScript fallback.
import packed from './packed.json';

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const enc = packed[decodeURIComponent(new URL(request.url).pathname)];
    if (!enc || res.status !== 200) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Encoding', enc);
    headers.delete('Content-Length');
    // 'manual': the body is already compressed, so the runtime must not compress it again
    return new Response(res.body, { status: 200, headers, encodeBody: 'manual' });
  },
};
