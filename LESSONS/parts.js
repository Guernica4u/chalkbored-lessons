// Rejoins files the lessons host stores in parts (it refuses files over 25 MB).
// A page sets, before loading this:  window.LESSON_PARTS = { 'Build/game.data': 3, ... }
// (path as the game asks for it, relative to the page; the parts are "<path>.part1" ... ".partN").
// Then every fetch() or XMLHttpRequest for that file gets the joined file instead.
(function () {
  const PARTS = window.LESSON_PARTS || {};
  const joined = {};
  const base = location.href.replace(/[^/]*([?#].*)?$/, '');

  function match(url) {
    let path;
    try { path = decodeURI(new URL(url, location.href).href); } catch (e) { return null; }
    for (const name in PARTS) if (path === decodeURI(base + name)) return name;
    return null;
  }

  function join(name) {
    if (!joined[name]) {
      const loads = [];
      for (let i = 1; i <= PARTS[name]; i++) {
        loads.push(origFetch(base + name + '.part' + i).then((r) => {
          if (!r.ok) throw new Error('missing part ' + i + ' of ' + name);
          return r.arrayBuffer();
        }));
      }
      const type = /\.wasm(\.|$)/.test(name) && !/unityweb|\.gz|\.br/.test(name) ? 'application/wasm' : 'application/octet-stream';
      joined[name] = Promise.all(loads).then((bufs) => new Blob(bufs, { type }));
    }
    return joined[name];
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const name = match(typeof input === 'string' ? input : input && input.url);
    if (!name) return origFetch(input, init);
    return join(name).then((blob) => new Response(blob, { status: 200, headers: { 'Content-Type': blob.type, 'Content-Length': String(blob.size) } }));
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__partsName = match(url);
    this.__partsArgs = arguments;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (!this.__partsName) return send.call(this, body);
    const xhr = this, args = Array.prototype.slice.call(this.__partsArgs);
    join(this.__partsName).then((blob) => {
      args[1] = URL.createObjectURL(blob);
      open.apply(xhr, args);
      send.call(xhr, body);
    }, (e) => { console.error(e); });
  };
})();
