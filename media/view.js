// Markdown Highlighter reader (webview side).
// Fast flow: select text -> click a colour (or press H / 1-4) -> keep reading.
// Chapters + Highlights panels and a marker rail let you jump back later.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = s => document.querySelector(s);
  const docEl = $('#doc'), tocEl = $('#toc'), hlEl = $('#hl'), railEl = $('#rail');
  const palette = $('#palette'), pop = $('#pop');
  const KIND_LABEL = { note: 'Highlight', question: 'Question', issue: 'Issue', approve: 'Good' };
  const BLOCK = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'PRE', 'BLOCKQUOTE', 'DIV', 'DT', 'DD', 'TR']);

  let highlights = [], me = 'You', showResolved = false, filter = 'all';
  let pendingRange = null;

  // --- text index: rendered text <-> DOM positions -------------------------------------------
  function stripMd(s) {
    return String(s)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX~!]\]\s+)?|\d+\.\s+)/gm, '')
      .replace(/(\*\*|__|~~|==|`)/g, '')
      .replace(/(^|[\s(])[*_](\S)/g, '$1$2').replace(/(\S)[*_](?=[\s).,;:!?]|$)/g, '$1')
      .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1').replace(/\|/g, ' ');
  }
  const collapse = s => s.replace(/\s+/g, ' ');
  const normQuote = s => collapse(stripMd(s)).trim();

  function blockOf(node) {
    let el = node.parentElement;
    while (el && el !== docEl && !BLOCK.has(el.tagName)) el = el.parentElement;
    return el;
  }

  /** {nodes, starts, norm, nmap}: norm is whitespace-collapsed text; nmap[i] -> index into raw text. */
  function buildIndex() {
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
    const nodes = [], starts = [];
    let raw = '', prevBlock = null, n;
    while ((n = walker.nextNode())) {
      const b = blockOf(n);
      if (prevBlock && b !== prevBlock) raw += ' ';  // separate block boundaries (table cells, list items)
      prevBlock = b;
      nodes.push(n); starts.push(raw.length); raw += n.nodeValue;
    }
    let norm = '', nmap = [], space = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (/\s/.test(c)) { if (!space && norm.length) { norm += ' '; nmap.push(i); } space = true; }
      else { norm += c; nmap.push(i); space = false; }
    }
    return { nodes, starts, raw, norm, nmap };
  }

  function locate(idx, rawPos) {  // raw index -> {node, offset}
    let lo = 0, hi = idx.nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (idx.starts[mid] <= rawPos) lo = mid; else hi = mid - 1; }
    return { i: lo, offset: rawPos - idx.starts[lo] };
  }

  function score(a, b) { let s = 0; for (let i = 1; i <= Math.min(a.length, b.length); i++) { if (a[a.length - i] !== b[b.length - i]) break; s++; } return s; }
  function scoreFwd(a, b) { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] !== b[i]) break; s++; } return s; }

  function wrapRange(idx, rawStart, rawEnd, h) {
    const a = locate(idx, rawStart), b = locate(idx, rawEnd - 1);
    const marks = [];
    for (let i = a.i; i <= b.i; i++) {
      let node = idx.nodes[i];
      const s = i === a.i ? a.offset : 0;
      const e = i === b.i ? b.offset + 1 : node.nodeValue.length;
      if (e <= s || !node.nodeValue.slice(s, e).trim() && i !== a.i) continue;
      if (s > 0) node = node.splitText(s);
      if (e - s < node.nodeValue.length) node.splitText(e - s);
      const m = document.createElement('mark');
      m.className = `hl k-${h.kind}` + (h.author !== me ? ' agent' : '') + (h.status === 'resolved' ? ' resolved' : '');
      m.dataset.id = h.id;
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
      marks.push(m);
    }
    return marks;
  }

  function applyOne(h) {
    const idx = buildIndex();
    const q = normQuote(h.quote);
    if (!q) return false;
    let best = -1, bestScore = -1, at = idx.norm.indexOf(q);
    while (at >= 0) {
      const sc = score(idx.norm.slice(0, at), collapse(h.prefix || '')) + scoreFwd(idx.norm.slice(at + q.length), collapse(h.suffix || ''));
      if (sc > bestScore) { best = at; bestScore = sc; }
      at = idx.norm.indexOf(q, at + 1);
    }
    if (best < 0) return false;
    const rawStart = idx.nmap[best], rawEnd = idx.nmap[best + q.length - 1] + 1;
    return wrapRange(idx, rawStart, rawEnd, h).length > 0;
  }

  function clearMarks() {
    docEl.querySelectorAll('mark.hl').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }

  function visible() { return highlights.filter(h => showResolved || h.status !== 'resolved'); }

  function applyAll() {
    clearMarks();
    for (const h of visible()) h._orphan = !applyOne(h);
    buildHighlightList();
    buildRail();
  }

  // --- chapters (table of contents) + scroll spy ----------------------------------------------
  let heads = [];
  function buildToc() {
    heads = [...docEl.querySelectorAll('h1, h2, h3')];
    tocEl.innerHTML = '';
    if (!heads.length) { tocEl.innerHTML = '<p class="empty">No headings in this document.</p>'; return; }
    for (const h of heads) {
      const a = document.createElement('a');
      a.textContent = h.textContent;
      a.className = 'lvl' + h.tagName[1];
      a.onclick = () => { h.scrollIntoView({ block: 'start' }); };
      h._toc = a;
      tocEl.appendChild(a);
    }
    spy();
  }

  function sectionOf(el) {
    let cur = null;
    for (const h of heads) { if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) cur = h; else break; }
    return cur ? cur.textContent : '';
  }

  let lastActive = null;
  function spy() {
    let cur = null;
    for (const h of heads) { if (h.getBoundingClientRect().top < 120) cur = h; else break; }
    if (cur !== lastActive) {
      lastActive && lastActive._toc && lastActive._toc.classList.remove('on');
      if (cur && cur._toc) { cur._toc.classList.add('on'); cur._toc.scrollIntoView({ block: 'nearest' }); }
      lastActive = cur;
    }
  }

  // --- highlights panel + marker rail -----------------------------------------------------------
  function buildHighlightList() {
    const vis = visible();
    const agentCount = vis.filter(h => h.author !== me && h.status !== 'resolved').length;
    $('#hlcount').textContent = vis.length ? vis.length : '';
    $('#agentnote').innerHTML = agentCount ? `<button id="agentbtn">${agentCount} from agents</button>` : '';
    const ab = $('#agentbtn');
    if (ab) ab.onclick = () => { setTab('hl'); filter = 'agents'; buildHighlightList(); };

    const items = vis.filter(h => filter === 'all' || (filter === 'mine' ? h.author === me : h.author !== me))
      .map(h => ({ h, el: docEl.querySelector(`mark[data-id="${h.id}"]`) }))
      .sort((a, b) => (a.el ? a.el.getBoundingClientRect().top + scrollY : 1e9) - (b.el ? b.el.getBoundingClientRect().top + scrollY : 1e9));
    hlEl.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'filters';
    for (const [k, label] of [['all', 'All'], ['mine', 'Mine'], ['agents', 'From agents']]) {
      const b = document.createElement('button');
      b.textContent = label; if (filter === k) b.className = 'on';
      b.onclick = () => { filter = k; buildHighlightList(); };
      bar.appendChild(b);
    }
    hlEl.appendChild(bar);
    if (!items.length) {
      const p = document.createElement('p'); p.className = 'empty';
      p.textContent = 'Select any text while reading, then click a colour (or press H) to mark it.';
      hlEl.appendChild(p);
    }
    for (const { h, el } of items) {
      const d = document.createElement('div');
      d.className = `item k-${h.kind}` + (h.status === 'resolved' ? ' resolved' : '');
      const sec = el ? sectionOf(el) : '';
      d.innerHTML = `<div class="q"></div><div class="meta"></div>` + (h.note ? '<div class="n"></div>' : '');
      d.querySelector('.q').textContent = h.quote;
      d.querySelector('.meta').textContent = [h.author !== me ? h.author : '', sec, h._orphan ? 'text changed: not found' : '', (h.replies || []).length ? `${h.replies.length} repl${h.replies.length === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(' · ');
      if (h.note) d.querySelector('.n').textContent = h.note;
      d.onclick = () => (el ? jump(h.id) : showPop(h, d));
      hlEl.appendChild(d);
    }
  }

  function buildRail() {
    railEl.innerHTML = '';
    const H = document.documentElement.scrollHeight;
    const seen = new Set();
    docEl.querySelectorAll('mark.hl').forEach(m => {
      if (seen.has(m.dataset.id)) return;
      seen.add(m.dataset.id);
      const t = document.createElement('div');
      t.className = 'tick ' + [...m.classList].filter(c => c.startsWith('k-') || c === 'agent').join(' ');
      t.style.top = ((m.getBoundingClientRect().top + scrollY) / H * 100) + '%';
      t.onclick = () => jump(m.dataset.id);
      railEl.appendChild(t);
    });
  }

  function jump(id) {
    const m = docEl.querySelector(`mark[data-id="${id}"]`);
    if (!m) return;
    m.scrollIntoView({ block: 'center' });
    docEl.querySelectorAll(`mark[data-id="${id}"]`).forEach(x => { x.classList.remove('flash'); void x.offsetWidth; x.classList.add('flash'); });
  }

  // --- making highlights ---------------------------------------------------------------------------
  function selectionInDoc() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!docEl.contains(r.commonAncestorContainer)) return null;
    if (!sel.toString().trim()) return null;
    return r;
  }

  function rawOffset(idx, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const i = idx.nodes.indexOf(container);
      if (i >= 0) return idx.starts[i] + offset;
    }
    // Element boundary: use the first text node at/after the boundary.
    const probe = document.createRange();
    probe.setStart(container, offset);
    for (let i = 0; i < idx.nodes.length; i++) {
      if (probe.comparePoint(idx.nodes[i], 0) >= 0) return idx.starts[i];
    }
    return idx.raw.length;
  }

  function showPalette(r) {
    pendingRange = r.cloneRange();
    const rect = r.getBoundingClientRect();
    palette.hidden = false;
    const x = Math.min(innerWidth - palette.offsetWidth - 8, Math.max(8, rect.right - palette.offsetWidth / 2));
    const y = rect.top - palette.offsetHeight - 8 < 8 ? rect.bottom + 8 : rect.top - palette.offsetHeight - 8;
    palette.style.left = x + 'px';
    palette.style.top = y + 'px';
  }

  function hidePalette() { palette.hidden = true; pendingRange = null; }

  function commit(kind) {
    if (!pendingRange) return;
    const idx = buildIndex();
    const s = rawOffset(idx, pendingRange.startContainer, pendingRange.startOffset);
    const e = rawOffset(idx, pendingRange.endContainer, pendingRange.endOffset);
    const quote = collapse(idx.raw.slice(s, e)).trim();
    if (!quote) return hidePalette();
    const prefix = collapse(idx.raw.slice(Math.max(0, s - 80), s)).slice(-32);
    const suffix = collapse(idx.raw.slice(e, e + 80)).slice(0, 32);
    vscode.postMessage({ type: 'add', kind, quote, prefix, suffix });
    getSelection().removeAllRanges();
    hidePalette();
  }

  palette.addEventListener('mousedown', e => e.preventDefault()); // keep the selection alive
  palette.querySelectorAll('button').forEach(b => b.addEventListener('click', () => commit(b.dataset.kind)));

  document.addEventListener('mouseup', e => {
    if (palette.contains(e.target) || pop.contains(e.target)) return;
    setTimeout(() => {
      const r = selectionInDoc();
      if (r) showPalette(r); else hidePalette();
    }, 0);
  });

  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('textarea, input')) return;
    if (e.key === 'Escape') { hidePalette(); hidePop(); return; }
    if (!palette.hidden || selectionInDoc()) {
      const r = selectionInDoc();
      if (r && palette.hidden) pendingRange = r.cloneRange();
      const kind = { h: 'note', 1: 'note', 2: 'question', 3: 'issue', 4: 'approve' }[e.key.toLowerCase()];
      if (kind && pendingRange) { e.preventDefault(); commit(kind); }
    }
  });

  // --- popover: note, replies, resolve --------------------------------------------------------------
  function hidePop() { pop.hidden = true; }

  function showPop(h, anchor) {
    const mine = h.author === me;
    const when = h.created ? new Date(h.created).toLocaleString() : '';
    pop.innerHTML = `
      <div class="kinds">${Object.keys(KIND_LABEL).map(k => `<button class="k-${k}${k === h.kind ? ' on' : ''}" data-kind="${k}" title="${KIND_LABEL[k]}"></button>`).join('')}
        <span class="who"></span></div>
      <div class="replies"></div>
      <textarea placeholder="${mine ? 'Add a note (optional)…' : 'Reply…'}" rows="2"></textarea>
      <div class="actions">
        <button class="save">${mine ? 'Save note' : 'Reply'}</button>
        <button class="status">${h.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
        ${mine ? '<button class="del">Delete</button>' : ''}
      </div>`;
    pop.querySelector('.who').textContent = `${mine ? 'You' : h.author} · ${when}`;
    const reps = pop.querySelector('.replies');
    if (!mine && h.note) { const n = document.createElement('div'); n.className = 'r'; n.innerHTML = '<b></b> '; n.querySelector('b').textContent = h.author + ':'; n.append(h.note); reps.appendChild(n); }
    for (const r of h.replies || []) { const n = document.createElement('div'); n.className = 'r'; n.innerHTML = '<b></b> '; n.querySelector('b').textContent = r.author + ':'; n.append(r.text); reps.appendChild(n); }
    const ta = pop.querySelector('textarea');
    if (mine) ta.value = h.note || '';
    pop.querySelectorAll('.kinds button').forEach(b => b.onclick = () => { vscode.postMessage({ type: 'kind', id: h.id, kind: b.dataset.kind }); hidePop(); });
    pop.querySelector('.save').onclick = () => {
      const v = ta.value.trim();
      if (mine) vscode.postMessage({ type: 'note', id: h.id, note: v });
      else if (v) vscode.postMessage({ type: 'reply', id: h.id, text: v });
      hidePop();
    };
    pop.querySelector('.status').onclick = () => { vscode.postMessage({ type: 'status', id: h.id, status: h.status === 'resolved' ? 'open' : 'resolved' }); hidePop(); };
    const del = pop.querySelector('.del');
    if (del) del.onclick = () => { vscode.postMessage({ type: 'delete', id: h.id }); hidePop(); };
    pop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + 8 + pop.offsetHeight > innerHeight ? Math.max(8, rect.top - pop.offsetHeight - 8) : rect.bottom + 8;
    pop.style.top = top + 'px';
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 12, Math.max(8, rect.left)) + 'px';
    if (mine && !h.note) ta.focus();
  }

  docEl.addEventListener('click', e => {
    const m = e.target.closest('mark.hl');
    if (m && getSelection().isCollapsed) {
      const h = highlights.find(x => x.id === m.dataset.id);
      if (h) showPop(h, m);
      return;
    }
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { const t = document.getElementById(decodeURIComponent(href.slice(1))); t && t.scrollIntoView({ block: 'start' }); }
      else vscode.postMessage({ type: 'link', href });
    }
  });
  document.addEventListener('mousedown', e => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('mark.hl')) hidePop(); });

  // --- tabs, scroll memory, wiring ---------------------------------------------------------------------
  function setTab(t) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    tocEl.hidden = t !== 'toc';
    hlEl.hidden = t !== 'hl';
  }
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $('#src').onclick = () => vscode.postMessage({ type: 'openSource' });

  let scrollT = 0;
  addEventListener('scroll', () => {
    spy();
    clearTimeout(scrollT);
    scrollT = setTimeout(() => vscode.postMessage({ type: 'scroll', y: scrollY }), 400);
  }, { passive: true });
  addEventListener('resize', buildRail);

  addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'render') {
      const y = scrollY;
      me = m.me; showResolved = m.showResolved; highlights = m.highlights;
      docEl.innerHTML = m.html;
      buildToc();
      applyAll();
      if (m.focus) setTimeout(() => jump(m.focus), 50);
      else scrollTo(0, m.keepScroll ? y : (m.scroll || 0));
      spy();
    } else if (m.type === 'highlights') {
      me = m.me; showResolved = m.showResolved; highlights = m.highlights;
      applyAll();
    } else if (m.type === 'focus') {
      jump(m.id);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
