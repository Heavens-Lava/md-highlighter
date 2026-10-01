// `mdhl serve`: the same reader in any web browser. Reads and writes the same
// .highlights/ files as the VS Code extension and agents, and shares "last read"
// snapshots, so all three stay in sync. Local-only by default; --lan needs a token.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const baseline = require('./baseline');
const actions = require('./actions');

const MEDIA = path.join(__dirname, '..', 'media');
const SKIP_DIRS = new Set(['node_modules', '.git', '.godot', '.highlights', '.vscode', '.idea', 'dist', 'build', 'out']);
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const ASSET = { 'view.js': 'text/javascript', 'view.css': 'text/css', 'web.css': 'text/css', 'web-shim.js': 'text/javascript', 'index.js': 'text/javascript' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function listDocs(root, dir = root, depth = 0, out = []) {
  if (depth > 8) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      listDocs(root, path.join(dir, e.name), depth + 1, out);
    } else if (/\.md$/i.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

function serve(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const port = Number(opts.port) || 4747;
  const lan = !!opts.lan;
  const me = opts.author || 'You';
  const token = lan ? crypto.randomBytes(12).toString('hex') : '';

  // Resolve a doc path from a request, refusing anything outside the root.
  function docFrom(rel) {
    if (!rel) return null;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    if (!/\.md$/i.test(abs) || !fs.existsSync(abs)) return null;
    return abs;
  }
  const relOf = abs => path.relative(root, abs).split(path.sep).join('/');

  function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  }
  const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

  function authed(req, url) {
    if (!lan) return true;
    if (url.searchParams.get('t') === token) return true;
    return (req.headers.cookie || '').split(/;\s*/).includes('mdhl=' + token);
  }

  function readBody(req) {
    return new Promise((ok, fail) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
      req.on('error', fail);
    });
  }

  function viewData(doc) {
    const dir = path.dirname(relOf(doc));
    const v = actions.view(doc, src => '/file?path=' + encodeURIComponent(path.posix.join(dir === '.' ? '' : dir, decodeURIComponent(src))));
    const st = baseline.state();
    return { ...v, highlights: store.load(doc, root).highlights, me, showResolved: false,
      prefs: st.prefs || {}, scroll: (st.scroll || {})[doc] || 0 };
  }

  // --- pages -----------------------------------------------------------------------------------
  function indexPage() {
    const docs = listDocs(root).sort((a, b) => relOf(a).localeCompare(relOf(b)));
    const rows = docs.map(d => {
      const rel = relOf(d);
      const hs = store.load(d, root).highlights.filter(h => h.status !== 'resolved');
      const agent = hs.filter(h => h.author !== me).length;
      const base = baseline.load(d);
      let text = '';
      try { text = fs.readFileSync(d, 'utf8'); } catch { /* unreadable */ }
      const badge = !base ? '<span class="b new">not read yet</span>' : base.text !== text ? '<span class="b upd">updated since you read it</span>' : '';
      const mtime = fs.statSync(d).mtime;
      return `<a class="doc" href="/view?doc=${encodeURIComponent(rel)}" data-q="${esc(rel.toLowerCase())}">
        <span class="name">${esc(path.basename(rel))}</span><span class="dir">${esc(path.dirname(rel) === '.' ? '' : path.dirname(rel))}</span>
        ${badge}${hs.length ? `<span class="b hl">${hs.length} highlight${hs.length === 1 ? '' : 's'}</span>` : ''}${agent ? `<span class="b ag">${agent} from agents</span>` : ''}
        <span class="when">${mtime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></a>`;
    }).join('\n');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(path.basename(root))} · Markdown Highlighter</title><link rel="stylesheet" href="/media/web.css"></head>
<body class="index"><header><h1>${esc(path.basename(root))}</h1><span class="sub">${docs.length} Markdown documents · Markdown Highlighter</span>
<input id="q" placeholder="Filter documents…" autofocus spellcheck="false"></header>
<main class="list">${rows || '<p class="empty">No Markdown files found.</p>'}</main>
<script src="/media/index.js"></script></body></html>`;
  }

  function readerPage(doc) {
    const rel = relOf(doc);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(path.basename(rel))} · Markdown Highlighter</title>
<link rel="stylesheet" href="/media/web.css"><link rel="stylesheet" href="/media/view.css"></head>
<body data-doc="${esc(rel)}">
<aside id="side">
  <div id="tabs"><button data-tab="toc" class="on">Chapters</button><button data-tab="hl">Highlights <span id="hlcount"></span></button><button data-tab="chg">Changes <span id="chgcount"></span></button></div>
  <nav id="toc"></nav><div id="hl" hidden></div><div id="chg" hidden></div>
</aside>
<main id="main"><div id="bar"><a id="home" href="/" title="All documents">← Files</a><span id="docname">${esc(path.basename(rel))}</span><span id="agentnote"></span><span id="chgnote"></span>
  <span id="find" hidden><input id="findq" placeholder="Find in document" spellcheck="false"><span id="findn"></span><button id="findprev" title="Previous (Shift+Enter)">↑</button><button id="findnext" title="Next (Enter)">↓</button><button id="findx" title="Close (Esc)">✕</button></span>
  <span class="tools"><button id="findbtn" title="Find (Ctrl+F)">⌕</button><button id="smaller" title="Smaller text">A−</button><button id="bigger" title="Larger text">A+</button><button id="width" title="Column width">⇔</button><button id="focusbtn" title="Focus mode (F)">◱</button><button id="src" title="Open in VS Code">Edit</button></span>
  <div id="progress"><div></div></div><span id="timeleft"></span></div><article id="doc"></article></main>
<div id="rail"></div>
<div id="palette" hidden>
  <button class="k-note" data-kind="note" title="Highlight (1 / H)"></button><button class="k-question" data-kind="question" title="Question (2)"></button>
  <button class="k-issue" data-kind="issue" title="Issue (3)"></button><button class="k-approve" data-kind="approve" title="Good (4)"></button>
</div>
<div id="pop" hidden></div>
<script src="/media/web-shim.js"></script><script src="/media/view.js"></script></body></html>`;
  }

  // --- live updates (Server-Sent Events) ------------------------------------------------------------
  const listeners = new Map(); // doc -> Set(res)
  const watchers = new Map();  // doc -> [watcher...]
  function push(doc, type) {
    for (const res of listeners.get(doc) || []) {
      try {
        const payload = type === 'render' ? { type, ...viewData(doc), keepScroll: true } : { type, highlights: store.load(doc, root).highlights, me, showResolved: false };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch { /* client gone */ }
    }
  }
  function watch(doc) {
    if (watchers.has(doc)) return;
    const debounce = {};
    const fire = type => { clearTimeout(debounce[type]); debounce[type] = setTimeout(() => push(doc, type), 150); };
    const ws = [];
    try { ws.push(fs.watch(doc, () => fire('render'))); } catch { /* ignore */ }
    const hlDir = path.dirname(store.storePath(doc, root));
    try {
      fs.mkdirSync(hlDir, { recursive: true });
      const name = path.basename(store.storePath(doc, root));
      ws.push(fs.watch(hlDir, (_e, f) => { if (f === name) fire('highlights'); }));
    } catch { /* ignore */ }
    watchers.set(doc, ws);
  }
  function unwatchIfIdle(doc) {
    if ((listeners.get(doc) || new Set()).size) return;
    (watchers.get(doc) || []).forEach(w => w.close());
    watchers.delete(doc);
  }

  // --- router ---------------------------------------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!authed(req, url)) return send(res, 403, 'Forbidden: open the link printed by mdhl serve.', 'text/plain');
    const cookie = lan && url.searchParams.get('t') === token ? { 'Set-Cookie': `mdhl=${token}; HttpOnly; SameSite=Strict; Path=/` } : {};
    try {
      if (url.pathname === '/') return send(res, 200, indexPage(), undefined, cookie);
      if (url.pathname.startsWith('/media/')) {
        const name = path.basename(url.pathname);
        if (!ASSET[name]) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, fs.readFileSync(path.join(MEDIA, name)), ASSET[name]);
      }
      if (url.pathname === '/file') {
        const abs = path.resolve(root, url.searchParams.get('path') || '');
        const type = IMG[path.extname(abs).toLowerCase()];
        if (!type || !abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, fs.readFileSync(abs), type);
      }
      const doc = docFrom(url.searchParams.get('doc'));
      if (url.pathname === '/view') return doc ? send(res, 200, readerPage(doc), undefined, cookie) : send(res, 404, 'No such document', 'text/plain');
      if (!doc) return json(res, { error: 'no such document' }, 404);

      if (url.pathname === '/api/view') return json(res, viewData(doc));
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        if (!listeners.has(doc)) listeners.set(doc, new Set());
        listeners.get(doc).add(res);
        watch(doc);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); listeners.get(doc).delete(res); unwatchIfIdle(doc); });
        return;
      }
      if (url.pathname === '/api/export') {
        const f = actions.EXPORT_FILTERS[url.searchParams.get('which')] || actions.EXPORT_FILTERS.open;
        const hs = store.load(doc, root).highlights.filter(f);
        return json(res, { count: hs.length, text: actions.exportText(doc, root, hs, me, url.searchParams.get('format') === 'tasks') });
      }
      if (url.pathname === '/api/msg' && req.method === 'POST') {
        const msg = await readBody(req);
        switch (msg.type) {
          case 'markRead': baseline.save(doc); return json(res, { type: 'render', ...viewData(doc), keepScroll: true });
          case 'read': baseline.save(doc); return json(res, { ok: true }); // tab closed / navigated away
          case 'scroll': { const st = baseline.state(); baseline.setState({ scroll: { ...(st.scroll || {}), [doc]: msg.y } }); return json(res, { ok: true }); }
          case 'prefs': baseline.setState({ prefs: msg.prefs }); return json(res, { ok: true });
          case 'openSource': spawn(process.platform === 'win32' ? 'code.cmd' : 'code', [doc], { shell: process.platform === 'win32', detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); return json(res, { ok: true });
        }
        if (actions.apply(doc, root, msg, me)) return json(res, { type: 'highlights', highlights: store.load(doc, root).highlights, me, showResolved: false });
        return json(res, { ok: false });
      }
      send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      json(res, { error: String(e && e.message || e) }, 500);
    }
  });

  const log = opts.log === false ? () => {} : (...a) => console.log(...a);
  server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
    const local = `http://localhost:${port}/`;
    if (opts.onListening) opts.onListening({ port, url: local, token });
    log(`Markdown Highlighter: serving ${root}`);
    log(`  Open: ${local}`);
    if (lan) {
      const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
      for (const ip of ips) log(`  On your phone/tablet (same Wi-Fi): http://${ip}:${port}/?t=${token}`);
      log('  The ?t= token is required; anyone with that link on your network can read and highlight these docs.');
    }
    log('  Ctrl+C to stop.');
    if (opts.open !== false) {
      const url = lan ? `http://localhost:${port}/?t=${token}` : local;
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  });
  server.on('error', e => {
    if (opts.onError) return opts.onError(e); // embedded (VS Code): let the caller decide
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy; try --port ${port + 1}` : String(e));
    process.exit(1);
  });
  return server;
}

module.exports = { serve, listDocs };
