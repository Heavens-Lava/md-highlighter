// Stands in for VS Code's webview API so the same reader (view.js) runs in a normal
// browser, talking to `mdhl serve` over HTTP + Server-Sent Events.
(function () {
  'use strict';
  const doc = document.body.dataset.doc;
  const q = 'doc=' + encodeURIComponent(doc);
  const deliver = m => window.postMessage(m, location.origin);

  function post(msg) {
    return fetch('/api/msg?' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
      .then(r => r.json()).catch(() => ({}));
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function exportDialog() {
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `<div class="card"><h3>Export highlights</h3>
      <label>Which <select id="exwhich"><option value="open">Open highlights</option><option value="issues">Only open issues &amp; questions</option><option value="all">Everything, including resolved</option></select></label>
      <div class="row"><button data-f="md">Copy as Markdown summary</button><button data-f="tasks">Copy as task list for an agent</button></div>
      <button class="close">Cancel</button></div>`;
    document.body.appendChild(box);
    const close = () => box.remove();
    box.querySelector('.close').onclick = close;
    box.addEventListener('click', e => { if (e.target === box) close(); });
    box.querySelectorAll('[data-f]').forEach(b => b.onclick = async () => {
      const which = box.querySelector('#exwhich').value;
      const r = await fetch(`/api/export?${q}&which=${which}&format=${b.dataset.f}`).then(x => x.json());
      if (!r.count) { toast('No highlights match.'); return; }
      try { await navigator.clipboard.writeText(r.text); toast(b.dataset.f === 'tasks' ? 'Copied: paste it to your agent.' : 'Copied highlights as Markdown.'); }
      catch { const w = window.open('', '_blank'); w.document.body.innerText = r.text; }
      close();
    });
  }

  function follow(href) {
    if (/^https?:/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    const [file, hash] = href.split('#');
    const base = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/') + 1) : '';
    const parts = (base + decodeURIComponent(file)).split('/');
    const out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
    const target = out.join('/');
    if (/\.md$/i.test(target)) location.href = '/view?doc=' + encodeURIComponent(target) + (hash ? '#' + hash : '');
    else window.open('/file?path=' + encodeURIComponent(target), '_blank');
  }

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      switch (msg.type) {
        case 'ready':
          fetch('/api/view?' + q).then(r => r.json()).then(d => {
            deliver({ type: 'render', ...d });
            if (location.hash) setTimeout(() => { const t = document.getElementById(decodeURIComponent(location.hash.slice(1))); t && t.scrollIntoView(); }, 50);
            // Live updates when an agent or VS Code edits the doc or its highlights.
            const es = new EventSource('/api/events?' + q);
            es.onmessage = e => deliver(JSON.parse(e.data));
          });
          break;
        case 'link': follow(msg.href); break;
        case 'export': exportDialog(); break;
        case 'openSource': post(msg).then(() => toast('Opening in VS Code…')); break;
        case 'scroll': case 'prefs': post(msg); break;
        default: post(msg).then(r => { if (r && r.type) deliver(r); }); // highlight edits, markRead
      }
    },
    setState() {}, getState() { return undefined; },
  });

  // Leaving the page counts as having read this version (like closing the tab in VS Code).
  addEventListener('pagehide', () => {
    navigator.sendBeacon('/api/msg?' + q, new Blob([JSON.stringify({ type: 'read' })], { type: 'application/json' }));
  });
})();
