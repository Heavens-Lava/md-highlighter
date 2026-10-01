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

  const chgEl = $('#chg');
  let highlights = [], me = 'You', showResolved = false, filter = 'all', hlQuery = '';
  let changes = [], since = null, words = 0;
  let prefs = { size: 15, wide: false, focus: false };
  let findOpen = false;
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

    const q = hlQuery.toLowerCase();
    const items = vis.filter(h => filter === 'all' || (filter === 'mine' ? h.author === me : h.author !== me))
      .filter(h => !q || [h.quote, h.note, h.author, ...(h.replies || []).map(r => r.text)].join(' ').toLowerCase().includes(q))
      .map(h => ({ h, el: docEl.querySelector(`mark[data-id="${h.id}"]`) }))
      .sort((a, b) => (a.el ? a.el.getBoundingClientRect().top + scrollY : 1e9) - (b.el ? b.el.getBoundingClientRect().top + scrollY : 1e9));
    // Header (filters, search, export) is built once so typing in the search box keeps focus.
    let head = hlEl.querySelector('.hlhead'), list = hlEl.querySelector('.hllist');
    if (!head) {
      head = document.createElement('div'); head.className = 'hlhead';
      head.innerHTML = '<div class="filters"></div><div class="hlsearch"><input placeholder="Search highlights & notes" spellcheck="false"><button class="export" title="Copy or save these highlights">Export</button></div>';
      head.querySelector('input').addEventListener('input', e => { hlQuery = e.target.value; buildHighlightList(); });
      head.querySelector('.export').onclick = () => vscode.postMessage({ type: 'export' });
      list = document.createElement('div'); list.className = 'hllist';
      hlEl.append(head, list);
    }
    const bar = head.querySelector('.filters');
    bar.innerHTML = '';
    for (const [k, label] of [['all', 'All'], ['mine', 'Mine'], ['agents', 'From agents']]) {
      const b = document.createElement('button');
      b.textContent = label; if (filter === k) b.className = 'on';
      b.onclick = () => { filter = k; buildHighlightList(); };
      bar.appendChild(b);
    }
    list.innerHTML = '';
    if (!items.length) {
      const p = document.createElement('p'); p.className = 'empty';
      p.textContent = q ? 'No highlights match.' : 'Select any text while reading, then click a colour (or press H) to mark it.';
      list.appendChild(p);
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
      list.appendChild(d);
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
    // Changes since last read: thin bars on the rail's left edge.
    docEl.querySelectorAll('.chg, .chg-removed-before, .chg-removed-after').forEach(el => {
      const t = document.createElement('div');
      t.className = 'ctick ' + (el.classList.contains('chg-added') ? 'added' : el.classList.contains('chg-edited') ? 'edited' : 'removed');
      t.style.top = ((el.getBoundingClientRect().top + scrollY) / H * 100) + '%';
      t.onclick = () => { el.scrollIntoView({ block: 'center' }); flashEl(el); };
      railEl.appendChild(t);
    });
  }

  function flashEl(el) { el.classList.remove('flash-block'); void el.offsetWidth; el.classList.add('flash-block'); }

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

  // --- changes since you last read --------------------------------------------------------------------
  function sinceText() {
    if (!since) return '';
    const d = new Date(since), mins = (Date.now() - d) / 60000;
    if (mins < 60) return `${Math.max(1, Math.round(mins))} min ago`;
    if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function buildChanges() {
    const n = changes.length;
    $('#chgcount').textContent = n || '';
    const note = $('#chgnote');
    note.innerHTML = '';
    if (n) {
      const b = document.createElement('button');
      b.className = 'chgchip';
      b.textContent = `${n} change${n === 1 ? '' : 's'} since you last read (${sinceText()})`;
      b.onclick = () => setTab('chg');
      note.appendChild(b);
    }
    chgEl.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'chghead';
    if (!since) head.innerHTML = '<p class="empty">First visit. From now on, anything that changes in this file (for example an agent\'s edits) is marked here the next time you open it.</p>';
    else if (!n) head.innerHTML = `<p class="empty">Nothing has changed since you last read this (${sinceText()}).</p>`;
    else {
      head.innerHTML = '<p class="empty"></p><button class="markread">Mark all as read</button>';
      head.querySelector('p').textContent = `Changed since ${sinceText()}. Added text is green, edited text amber, removed text shows as a red line.`;
      head.querySelector('.markread').onclick = () => vscode.postMessage({ type: 'markRead' });
    }
    chgEl.appendChild(head);
    for (const c of changes) {
      const el = docEl.querySelector(`[data-chg="${c.id}"]`);
      if (!el) continue;
      const d = document.createElement('div');
      d.className = 'item c-' + c.type;
      const label = { added: 'Added', edited: 'Edited', removed: 'Removed' }[c.type];
      const text = c.type === 'removed' ? c.oldText : el.textContent;
      d.innerHTML = '<div class="q"></div><div class="meta"></div>';
      d.querySelector('.q').textContent = text.replace(/\s+/g, ' ').trim().slice(0, 160) || '(blank)';
      d.querySelector('.meta').textContent = [label, sectionOf(el)].filter(Boolean).join(' · ');
      d.onclick = () => { el.scrollIntoView({ block: 'center' }); flashEl(el); };
      chgEl.appendChild(d);
    }
  }

  // --- checklist progress under each heading ---------------------------------------------------------------
  function sectionBlocks(h) {  // siblings after heading h until the next heading of the same or higher level
    const lvl = +h.tagName[1], out = [];
    for (let el = h.nextElementSibling; el; el = el.nextElementSibling) {
      if (/^H[1-6]$/.test(el.tagName) && +el.tagName[1] <= lvl) break;
      out.push(el);
    }
    return out;
  }

  function buildProgress() {
    docEl.querySelectorAll('.progress-row').forEach(e => e.remove());
    for (const h of docEl.querySelectorAll('h1, h2, h3')) {
      const tasks = sectionBlocks(h).flatMap(el => [...el.querySelectorAll('li.task')].concat(el.matches('li.task') ? [el] : []));
      if (!tasks.length) continue;
      const c = { done: 0, review: 0, blocked: 0, todo: 0 };
      tasks.forEach(t => { for (const k in c) if (t.classList.contains('t-' + k)) c[k]++; });
      const total = tasks.length;
      const row = document.createElement('div');
      row.className = 'progress-row';
      const parts = [`${c.done}/${total} done`];
      if (c.review) parts.push(`${c.review} awaiting review`);
      if (c.blocked) parts.push(`${c.blocked} blocked`);
      row.dataset.label = parts.join(' · ');
      row.innerHTML = '<div class="pbar"><i class="p-done"></i><i class="p-review"></i><i class="p-blocked"></i></div>';
      const [a, b, d] = row.querySelectorAll('i');
      a.style.width = (c.done / total * 100) + '%';
      b.style.width = (c.review / total * 100) + '%';
      d.style.width = (c.blocked / total * 100) + '%';
      h.after(row);
      if (h._toc) h._toc.dataset.count = `${c.done}/${total}` + (c.blocked ? ' !' : '');
    }
  }

  // --- collapsible sections -------------------------------------------------------------------------------------
  function addCollapsers() {
    for (const h of docEl.querySelectorAll('h2, h3')) {
      const b = document.createElement('button');
      b.className = 'fold';
      b.title = 'Collapse / expand this section';
      b.onclick = e => {
        e.stopPropagation();
        const closed = h.classList.toggle('folded');
        sectionBlocks(h).forEach(el => { el.classList.toggle('folded-away', closed); });
        buildRail();
      };
      h.prepend(b);
    }
  }

  // --- reading comfort: text size, width, focus, progress + time left -----------------------------------------
  function applyPrefs() {
    document.documentElement.style.setProperty('--read-size', prefs.size + 'px');
    document.body.classList.toggle('wide', !!prefs.wide);
    document.body.classList.toggle('focus', !!prefs.focus);
  }
  function savePrefs() { applyPrefs(); vscode.postMessage({ type: 'prefs', prefs }); requestAnimationFrame(buildRail); }
  $('#smaller').onclick = () => { prefs.size = Math.max(12, prefs.size - 1); savePrefs(); };
  $('#bigger').onclick = () => { prefs.size = Math.min(24, prefs.size + 1); savePrefs(); };
  $('#width').onclick = () => { prefs.wide = !prefs.wide; savePrefs(); };
  $('#focusbtn').onclick = () => { prefs.focus = !prefs.focus; savePrefs(); };

  function updateProgress() {
    const max = document.documentElement.scrollHeight - innerHeight;
    const f = max > 0 ? Math.min(1, scrollY / max) : 1;
    $('#progress div').style.width = (f * 100) + '%';
    const left = Math.round(words * (1 - f) / 230);
    $('#timeleft').textContent = f >= 0.995 ? 'done' : left < 1 ? '< 1 min left' : `${left} min left`;
  }

  // --- find in document (CSS Custom Highlight API: no DOM changes) ---------------------------------------------
  let findRanges = [], findIdx = -1;
  const canHighlight = typeof Highlight !== 'undefined' && CSS.highlights;
  function openFind() {
    findOpen = true;
    $('#find').hidden = false;
    const q = $('#findq');
    const sel = getSelection().toString().trim();
    if (sel && sel.length < 80) q.value = sel;
    q.focus(); q.select();
    runFind();
  }
  function closeFind() {
    findOpen = false;
    $('#find').hidden = true;
    findRanges = []; findIdx = -1;
    if (canHighlight) { CSS.highlights.delete('find'); CSS.highlights.delete('find-current'); }
  }
  function runFind() {
    const q = $('#findq').value.toLowerCase();
    findRanges = []; findIdx = -1;
    if (q.length >= 2) {
      const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.parentElement.closest('.folded-away')) continue;
        const t = n.nodeValue.toLowerCase();
        for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) {
          const r = new Range(); r.setStart(n, i); r.setEnd(n, i + q.length); findRanges.push(r);
        }
      }
    }
    if (canHighlight) CSS.highlights.set('find', new Highlight(...findRanges));
    if (findRanges.length) {  // start from the first match below the current view
      findIdx = findRanges.findIndex(r => r.getBoundingClientRect().top > 60);
      if (findIdx < 0) findIdx = 0;
      showFind(false);
    } else {
      $('#findn').textContent = q.length >= 2 ? 'no matches' : '';
      if (canHighlight) CSS.highlights.delete('find-current');
    }
  }
  function showFind(scroll = true) {
    const r = findRanges[findIdx];
    $('#findn').textContent = `${findIdx + 1}/${findRanges.length}`;
    if (canHighlight) CSS.highlights.set('find-current', new Highlight(r));
    if (scroll) {
      const rect = r.getBoundingClientRect();
      scrollBy({ top: rect.top - innerHeight / 3 });
    }
  }
  function stepFind(d) {
    if (!findRanges.length) return;
    findIdx = (findIdx + d + findRanges.length) % findRanges.length;
    showFind();
  }
  $('#findbtn').onclick = openFind;
  $('#findx').onclick = closeFind;
  $('#findnext').onclick = () => stepFind(1);
  $('#findprev').onclick = () => stepFind(-1);
  $('#findq').addEventListener('input', runFind);
  $('#findq').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
    if (e.target.closest && e.target.closest('textarea, input')) return;
    if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !selectionInDoc()) { prefs.focus = !prefs.focus; savePrefs(); }
  });

  // --- tabs, scroll memory, wiring ---------------------------------------------------------------------
  function setTab(t) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    tocEl.hidden = t !== 'toc';
    hlEl.hidden = t !== 'hl';
    chgEl.hidden = t !== 'chg';
  }
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $('#src').onclick = () => vscode.postMessage({ type: 'openSource' });
  if ($('#browser')) $('#browser').onclick = () => vscode.postMessage({ type: 'openBrowser' });

  let scrollT = 0;
  addEventListener('scroll', () => {
    spy();
    updateProgress();
    clearTimeout(scrollT);
    scrollT = setTimeout(() => vscode.postMessage({ type: 'scroll', y: scrollY }), 400);
  }, { passive: true });
  addEventListener('resize', buildRail);

  addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'render') {
      const y = scrollY;
      me = m.me; showResolved = m.showResolved; highlights = m.highlights;
      changes = m.changes || []; since = m.since; words = m.words || 0;
      if (m.prefs) { prefs = Object.assign(prefs, m.prefs); applyPrefs(); }
      docEl.innerHTML = m.html;
      addCollapsers();
      buildToc();
      buildProgress();
      buildChanges();
      applyAll();
      if (findOpen) runFind();
      if (m.focus) setTimeout(() => jump(m.focus), 50);
      else scrollTo(0, m.keepScroll ? y : (m.scroll || 0));
      spy();
      updateProgress();
    } else if (m.type === 'highlights') {
      me = m.me; showResolved = m.showResolved; highlights = m.highlights;
      applyAll();
    } else if (m.type === 'focus') {
      jump(m.id);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
