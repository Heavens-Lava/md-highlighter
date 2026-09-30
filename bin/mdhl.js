#!/usr/bin/env node
// mdhl — read and write Markdown highlights from the command line (for AI agents and scripts).
// Highlights live in <root>/.highlights/<doc>.md.json and show up in the VS Code
// "Markdown Highlighter" view. Author defaults to $MDHL_AUTHOR, then $INVENTOR_AGENT, then "Agent".
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const HELP = `mdhl — Markdown highlights for humans and agents

  mdhl add <doc.md> --quote "exact text" [--kind note|question|issue|approve] [--note "..."]
  mdhl list [doc.md] [--open] [--author NAME] [--not-author NAME] [--json]
  mdhl reply <doc.md> <id> "text"
  mdhl resolve <doc.md> <id>          mdhl reopen <doc.md> <id>
  mdhl delete <doc.md> <id>           (only your own highlights)
  mdhl path <doc.md>                  where the JSON lives

Options: --author NAME (default $MDHL_AUTHOR / $INVENTOR_AGENT / "Agent"), --root DIR
Quotes are matched against the doc with Markdown syntax stripped, so you can quote
either the source or the rendered text. Keep quotes short and unique (a phrase or sentence).
Tip: see what the human flagged for you:  mdhl list --open --author You`;

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}

function die(msg) { console.error('mdhl: ' + msg); process.exit(1); }

function author(opt) {
  return opt.author || process.env.MDHL_AUTHOR || process.env.INVENTOR_AGENT || 'Agent';
}

function ctx(doc, opt) {
  if (!doc) die('missing <doc.md>');
  if (!fs.existsSync(doc)) die('no such file: ' + doc);
  const root = opt.root ? path.resolve(opt.root) : store.findRoot(doc);
  return { doc: path.resolve(doc), root, data: store.load(doc, root) };
}

function find(data, id) {
  const h = data.highlights.find(x => x.id === id);
  if (!h) die('no highlight ' + id);
  return h;
}

function fmt(h, docRel) {
  const q = h.quote.length > 90 ? h.quote.slice(0, 87) + '…' : h.quote;
  const lines = [`${h.id}  [${h.kind}${h.status === 'resolved' ? ', resolved' : ''}]  ${h.author}  ${docRel || ''}`, `    “${q}”`];
  if (h.note) lines.push('    note: ' + h.note);
  for (const r of h.replies || []) lines.push(`    ↳ ${r.author}: ${r.text}`);
  return lines.join('\n');
}

const { pos, opt } = parse(process.argv.slice(2));
const cmd = pos[0];

switch (cmd) {
  case 'add': {
    const c = ctx(pos[1], opt);
    const quote = opt.quote;
    if (!quote || quote === true) die('--quote "text" is required');
    const source = fs.readFileSync(c.doc, 'utf8');
    const at = store.findQuote(source, quote);
    if (at < 0) die('quote not found in ' + pos[1] + ' (quote an exact phrase from the doc)');
    const n = store.norm(source);
    const q = store.norm(quote);
    const kind = store.KINDS.includes(opt.kind) ? opt.kind : 'note';
    const h = {
      id: store.newId(), quote: q,
      prefix: n.slice(Math.max(0, at - 32), at), suffix: n.slice(at + q.length, at + q.length + 32),
      kind, note: opt.note && opt.note !== true ? String(opt.note) : '',
      author: author(opt), created: new Date().toISOString(), status: 'open', replies: [],
    };
    c.data.highlights.push(h);
    store.save(c.doc, c.data, c.root);
    console.log(`added ${h.id} (${kind}) to ${path.relative(c.root, c.doc)}`);
    break;
  }
  case 'list': {
    let entries;
    if (pos[1]) {
      const c = ctx(pos[1], opt);
      entries = [{ doc: c.doc, data: c.data, root: c.root }];
    } else {
      const root = opt.root ? path.resolve(opt.root) : store.findRoot(path.join(process.cwd(), 'x.md'));
      entries = store.all(root).map(e => ({ ...e, root }));
    }
    const rows = [];
    for (const e of entries) {
      for (const h of e.data.highlights) {
        if (opt.open && h.status === 'resolved') continue;
        if (opt.author && opt.author !== true && h.author !== opt.author) continue;
        if (opt['not-author'] && h.author === opt['not-author']) continue;
        rows.push({ doc: path.relative(e.root, e.doc).replace(/\\/g, '/'), ...h });
      }
    }
    if (opt.json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('no highlights');
    else console.log(rows.map(r => fmt(r, r.doc)).join('\n\n'));
    break;
  }
  case 'reply': {
    const c = ctx(pos[1], opt);
    const h = find(c.data, pos[2]);
    const text = pos[3];
    if (!text) die('missing reply text');
    (h.replies = h.replies || []).push({ author: author(opt), text, created: new Date().toISOString() });
    store.save(c.doc, c.data, c.root);
    console.log('replied to ' + h.id);
    break;
  }
  case 'resolve':
  case 'reopen': {
    const c = ctx(pos[1], opt);
    const h = find(c.data, pos[2]);
    h.status = cmd === 'resolve' ? 'resolved' : 'open';
    h.resolvedBy = cmd === 'resolve' ? author(opt) : undefined;
    store.save(c.doc, c.data, c.root);
    console.log(`${cmd}d ${h.id}`);
    break;
  }
  case 'delete': {
    const c = ctx(pos[1], opt);
    const h = find(c.data, pos[2]);
    if (h.author !== author(opt)) die(`${h.id} belongs to ${h.author}; resolve it instead of deleting`);
    c.data.highlights = c.data.highlights.filter(x => x !== h);
    store.save(c.doc, c.data, c.root);
    console.log('deleted ' + h.id);
    break;
  }
  case 'path': {
    const c = ctx(pos[1], opt);
    console.log(store.storePath(c.doc, c.root));
    break;
  }
  default:
    console.log(HELP);
}
