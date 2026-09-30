// Shared highlight store for the VS Code extension and the `mdhl` CLI.
// A doc at <root>/a/b.md keeps its highlights in <root>/.highlights/a/b.md.json.
// Highlights are anchored by quoted text (+ a little context), so they survive edits
// and an agent can create one just by quoting the passage.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = '.highlights';
const ROOT_MARKERS = ['.highlights', '.git', '.vscode', '.inventor.json', 'package.json', 'project.godot'];
const KINDS = ['note', 'question', 'issue', 'approve'];

/** Nearest ancestor of `file` that looks like a project root (has .highlights, .git, a
 *  manifest…). The nearest one wins, so a stray marker in the home folder never captures
 *  a project's highlights. Falls back to the file's own folder. */
function findRoot(file) {
  const start = path.dirname(path.resolve(file));
  let dir = start;
  for (;;) {
    if (ROOT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

function storePath(doc, root = findRoot(doc)) {
  const rel = path.relative(root, path.resolve(doc));
  return path.join(root, DIR, rel + '.json');
}

function relDoc(doc, root) {
  return path.relative(root || findRoot(doc), path.resolve(doc)).split(path.sep).join('/');
}

function load(doc, root) {
  const p = storePath(doc, root);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    data.highlights = data.highlights || [];
    return data;
  } catch {
    return { version: 1, doc: relDoc(doc, root), highlights: [] };
  }
}

function save(doc, data, root) {
  const p = storePath(doc, root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function newId() {
  return 'h_' + crypto.randomBytes(4).toString('hex');
}

/** Strip Markdown inline/block syntax so a quote from the source matches rendered text. */
function stripMd(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX~!]\]\s+)?|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/(^|[\s(])[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=[\s).,;:!?]|$)/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1')
    .replace(/\|/g, ' ');
}

function norm(s) {
  return stripMd(s).replace(/\s+/g, ' ').trim();
}

/** Where `quote` occurs in the doc source (normalised), or -1. */
function findQuote(source, quote) {
  return norm(source).indexOf(norm(quote));
}

function all(root) {
  const base = path.join(root, DIR);
  const out = [];
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          const doc = path.join(root, path.relative(base, p).replace(/\.json$/, ''));
          out.push({ doc, data });
        } catch { /* skip unreadable */ }
      }
    }
  })(base);
  return out;
}

module.exports = { DIR, KINDS, findRoot, storePath, load, save, newId, stripMd, norm, findQuote, all };
