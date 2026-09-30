// Reader actions shared by the VS Code extension and the web server:
// rendering a doc for the reader, applying highlight edits, and export text.
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');
const baseline = require('./baseline');
const { render } = require('./render');
const { diffLines } = require('./diff');

/** Everything the reader needs to draw a doc. `image` rewrites relative image src. */
function view(doc, image) {
  const source = fs.readFileSync(doc, 'utf8');
  const base = baseline.load(doc);
  const hunks = base && base.text !== source ? diffLines(base.text, source) : [];
  const out = render(source, { hunks, image });
  return { html: out.html, changes: out.changes, since: base ? base.time : null, words: source.split(/\s+/).length };
}

const MUTATIONS = new Set(['add', 'note', 'kind', 'reply', 'status', 'delete']);

/** Apply a highlight edit from the reader. Returns true if the store changed. */
function apply(doc, root, msg, author) {
  if (!MUTATIONS.has(msg.type)) return false;
  const data = store.load(doc, root);
  const find = () => data.highlights.find(x => x.id === msg.id);
  switch (msg.type) {
    case 'add':
      data.highlights.push({
        id: store.newId(), quote: String(msg.quote || ''), prefix: msg.prefix || '', suffix: msg.suffix || '',
        kind: store.KINDS.includes(msg.kind) ? msg.kind : 'note', note: '', author,
        created: new Date().toISOString(), status: 'open', replies: [],
      });
      break;
    case 'note': { const h = find(); if (h) h.note = String(msg.note || ''); break; }
    case 'kind': { const h = find(); if (h && store.KINDS.includes(msg.kind)) h.kind = msg.kind; break; }
    case 'reply': {
      const h = find();
      if (h && msg.text) (h.replies = h.replies || []).push({ author, text: String(msg.text), created: new Date().toISOString() });
      break;
    }
    case 'status': {
      const h = find();
      if (h) { h.status = msg.status === 'resolved' ? 'resolved' : 'open'; h.resolvedBy = h.status === 'resolved' ? author : undefined; }
      break;
    }
    case 'delete': data.highlights = data.highlights.filter(x => x.id !== msg.id); break;
  }
  store.save(doc, data, root);
  return true;
}

const LABEL = { note: 'Highlight', question: 'Question', issue: 'Issue', approve: 'Good' };

/** Highlights as Markdown: a summary, or a task list to paste to an agent. */
function exportText(doc, root, hs, me, asTasks) {
  const rel = path.relative(root, doc).split(path.sep).join('/');
  const lines = [asTasks ? `Please address these highlights I left in \`${rel}\`:` : `# Highlights: ${rel}`, ''];
  for (const h of hs) {
    const head = asTasks ? `- [ ] **${LABEL[h.kind]}:** “${h.quote}”` : `- **${LABEL[h.kind]}** — “${h.quote}”`;
    lines.push(head + (h.author !== me ? ` _(from ${h.author})_` : ''));
    if (h.note) lines.push(`  - ${asTasks && h.author === me ? 'My note' : 'Note'}: ${h.note}`);
    for (const r of h.replies || []) lines.push(`  - ${r.author}: ${r.text}`);
  }
  if (asTasks) lines.push('', `(Highlight ids are in .highlights/${rel}.json; reply or resolve them with the mdhl CLI.)`);
  return lines.join('\n') + '\n';
}

const EXPORT_FILTERS = {
  open: h => h.status !== 'resolved',
  issues: h => h.status !== 'resolved' && (h.kind === 'issue' || h.kind === 'question'),
  all: () => true,
};

module.exports = { view, apply, exportText, EXPORT_FILTERS, MUTATIONS };
