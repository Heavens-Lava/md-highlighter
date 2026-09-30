// Markdown -> HTML for the reader: heading ids, checklist status chips, and
// "changed since you last read" markers. Shared by the extension and tests.
'use strict';
const MarkdownIt = require('markdown-it');

const TASK = /^\[( |x|X|~|!)\]\s+/;
const TASK_STATE = { ' ': 'todo', x: 'done', X: 'done', '~': 'review', '!': 'blocked' };
const TASK_TITLE = { todo: 'Not started', done: 'Done', review: 'Built, awaiting verification', blocked: 'Blocked / decision needed' };

function slugger() {
  const used = new Set();
  return text => {
    const base = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'section';
    let id = base, n = 1;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * @param {string} source    Markdown text
 * @param {object} [opts]
 * @param {Array}  [opts.hunks]     from diffLines(): tint changed blocks
 * @param {(src:string)=>string} [opts.image] rewrite relative image src
 * @returns {{html:string, changes:Array<{id,type,oldText}>}}
 */
function render(source, opts = {}) {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const slug = slugger();
  const hunks = opts.hunks || [];

  // Checklist chips: "- [~] text" -> <li class="task t-review"><span class="task-chip">…
  md.core.ruler.after('inline', 'task-chips', state => {
    const t = state.tokens;
    for (let i = 2; i < t.length; i++) {
      if (t[i].type !== 'inline' || t[i - 1].type !== 'paragraph_open' || t[i - 2].type !== 'list_item_open') continue;
      const first = t[i].children[0];
      if (!first || first.type !== 'text') continue;
      const m = first.content.match(TASK);
      if (!m) continue;
      const st = TASK_STATE[m[1]];
      first.content = first.content.slice(m[0].length);
      const chip = new state.Token('html_inline', '', 0);
      chip.content = `<span class="task-chip" data-state="${st}" title="${TASK_TITLE[st]}"></span>`;
      t[i].children.unshift(chip);
      t[i - 2].attrJoin('class', `task t-${st}`);
    }
  });

  const tokens = md.parse(source, {});

  // Change markers: tint the innermost rendered block whose source lines overlap a hunk.
  const changes = [];
  if (hunks.length) {
    const blockAt = [];      // candidate block tokens in order: {tok, from, to}
    const liStack = [];
    for (const tok of tokens) {
      if (tok.type === 'list_item_open') liStack.push(tok);
      if (tok.type === 'list_item_close') liStack.pop();
      if (!tok.map) continue;
      const [from, to] = tok.map;
      if (tok.type === 'paragraph_open') blockAt.push({ tok: tok.hidden ? liStack[liStack.length - 1] : tok, from, to });
      else if (['heading_open', 'tr_open', 'fence', 'code_block', 'hr', 'html_block'].includes(tok.type)) blockAt.push({ tok, from, to });
    }
    hunks.forEach((h, n) => {
      const id = 'c' + n;
      let target = null, after = false;
      if (h.type === 'removed') {
        target = blockAt.find(b => b.from >= h.start);
        if (!target) { target = blockAt[blockAt.length - 1]; after = true; } // removed from the end
      } else {
        const hits = blockAt.filter(b => b.from < h.end && b.to > h.start);
        hits.forEach((b, k) => {
          if (!b.tok) return;
          b.tok.attrJoin('class', `chg chg-${h.type}`);
          if (k === 0) b.tok.attrSet('data-chg', id);
        });
        target = hits[0];
      }
      if (h.type === 'removed' && target && target.tok) {
        target.tok.attrJoin('class', after ? 'chg-removed-after' : 'chg-removed-before');
        if (!target.tok.attrGet('data-chg')) target.tok.attrSet('data-chg', id);
        target.tok.attrSet('data-removed', h.oldText.slice(0, 300));
      }
      if (target && target.tok) changes.push({ id, type: h.type, oldText: h.oldText.slice(0, 300) });
    });
  }

  md.renderer.rules.heading_open = (toks, i, o, env, self) => {
    const text = toks[i + 1].children.map(c => c.content).join('');
    toks[i].attrSet('id', slug(text));
    return self.renderToken(toks, i, o);
  };
  if (opts.image) {
    const imgDefault = md.renderer.rules.image;
    md.renderer.rules.image = (toks, i, o, env, self) => {
      const src = toks[i].attrGet('src') || '';
      if (src && !/^(https?:|data:)/i.test(src)) toks[i].attrSet('src', opts.image(src));
      return imgDefault(toks, i, o, env, self);
    };
  }
  return { html: md.renderer.render(tokens, md.options, {}), changes };
}

module.exports = { render, escapeHtml };
