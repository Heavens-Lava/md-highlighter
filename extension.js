// Markdown Highlighter — VS Code extension host.
// Renders a Markdown file in a webview reader where you can highlight while you read,
// jump by chapter or highlight, and see highlights agents left for you.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const store = require('./lib/store');

const panels = new Map(); // doc path -> { panel, disposables }
let tree;
let status;
let showResolved = false;

function author() {
  return vscode.workspace.getConfiguration('mdHighlighter').get('author') || 'You';
}

function rootFor(doc) {
  const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(doc));
  if (wf && fs.existsSync(path.join(wf.uri.fsPath, store.DIR))) return wf.uri.fsPath;
  return store.findRoot(doc) || (wf && wf.uri.fsPath);
}

function slug(s, used) {
  let base = s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'section';
  let id = base, n = 1;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

function render(doc, webview) {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const used = new Set();
  md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
    const text = tokens[i + 1].children.map(t => t.content).join('');
    tokens[i].attrSet('id', slug(text, used));
    return self.renderToken(tokens, i, opts);
  };
  const imgDefault = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, i, opts, env, self) => {
    const src = tokens[i].attrGet('src') || '';
    if (src && !/^(https?:|data:)/i.test(src)) {
      const abs = path.resolve(path.dirname(doc), decodeURIComponent(src));
      tokens[i].attrSet('src', webview.asWebviewUri(vscode.Uri.file(abs)).toString());
    }
    return imgDefault(tokens, i, opts, env, self);
  };
  return md.render(fs.readFileSync(doc, 'utf8'));
}

function nonce() {
  return require('crypto').randomBytes(16).toString('base64');
}

function shell(webview, ctx, doc) {
  const media = f => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', f));
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('view.css')}">
<title>${path.basename(doc)}</title></head>
<body>
<aside id="side">
  <div id="tabs"><button data-tab="toc" class="on">Chapters</button><button data-tab="hl">Highlights <span id="hlcount"></span></button></div>
  <nav id="toc"></nav>
  <div id="hl" hidden></div>
</aside>
<main id="main"><div id="bar"><span id="docname">${path.basename(doc)}</span><span id="agentnote"></span><button id="src" title="Open the source file">Source</button></div><article id="doc"></article></main>
<div id="rail"></div>
<div id="palette" hidden>
  <button class="k-note" data-kind="note" title="Highlight (1 / H)"></button>
  <button class="k-question" data-kind="question" title="Question (2)"></button>
  <button class="k-issue" data-kind="issue" title="Issue (3)"></button>
  <button class="k-approve" data-kind="approve" title="Good (4)"></button>
</div>
<div id="pop" hidden></div>
<script nonce="${n}" src="${media('view.js')}"></script>
</body></html>`;
}

function highlightsFor(doc) {
  return store.load(doc, rootFor(doc)).highlights;
}

function mutate(doc, fn) {
  const root = rootFor(doc);
  const data = store.load(doc, root);
  fn(data);
  store.save(doc, data, root);
}

function send(doc, extra = {}) {
  const p = panels.get(doc);
  if (!p) return;
  p.panel.webview.postMessage({ type: 'render', html: render(doc, p.panel.webview), highlights: highlightsFor(doc), me: author(), showResolved, ...extra });
}

function sendHighlights(doc) {
  const p = panels.get(doc);
  if (p) p.panel.webview.postMessage({ type: 'highlights', highlights: highlightsFor(doc), me: author(), showResolved });
}

function open(ctx, uri, focusId) {
  const doc = (uri || vscode.window.activeTextEditor?.document.uri)?.fsPath;
  if (!doc || !doc.toLowerCase().endsWith('.md')) {
    vscode.window.showWarningMessage('Open a Markdown file first.');
    return;
  }
  const existing = panels.get(doc);
  if (existing) {
    existing.panel.reveal();
    if (focusId) existing.panel.webview.postMessage({ type: 'focus', id: focusId });
    return;
  }
  const panel = vscode.window.createWebviewPanel('mdHighlighter', '✎ ' + path.basename(doc), vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media'), vscode.Uri.file(path.dirname(doc)),
      ...(vscode.workspace.workspaceFolders || []).map(f => f.uri)],
  });
  panel.webview.html = shell(panel.webview, ctx, doc);
  const disposables = [];
  const entry = { panel, disposables, pendingFocus: focusId };
  panels.set(doc, entry);

  const watchDoc = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(doc), path.basename(doc)));
  watchDoc.onDidChange(() => send(doc, { keepScroll: true }));
  disposables.push(watchDoc);

  panel.webview.onDidReceiveMessage(msg => {
    switch (msg.type) {
      case 'ready': {
        const scroll = ctx.workspaceState.get('scroll:' + doc, 0);
        send(doc, { scroll, focus: entry.pendingFocus });
        entry.pendingFocus = undefined;
        break;
      }
      case 'scroll':
        ctx.workspaceState.update('scroll:' + doc, msg.y);
        break;
      case 'add':
        mutate(doc, d => d.highlights.push({
          id: store.newId(), quote: msg.quote, prefix: msg.prefix || '', suffix: msg.suffix || '',
          kind: store.KINDS.includes(msg.kind) ? msg.kind : 'note', note: '', author: author(),
          created: new Date().toISOString(), status: 'open', replies: [],
        }));
        break;
      case 'note':
        mutate(doc, d => { const h = d.highlights.find(x => x.id === msg.id); if (h) h.note = msg.note; });
        break;
      case 'kind':
        mutate(doc, d => { const h = d.highlights.find(x => x.id === msg.id); if (h) h.kind = msg.kind; });
        break;
      case 'reply':
        mutate(doc, d => {
          const h = d.highlights.find(x => x.id === msg.id);
          if (h) (h.replies = h.replies || []).push({ author: author(), text: msg.text, created: new Date().toISOString() });
        });
        break;
      case 'status':
        mutate(doc, d => { const h = d.highlights.find(x => x.id === msg.id); if (h) { h.status = msg.status; h.resolvedBy = msg.status === 'resolved' ? author() : undefined; } });
        break;
      case 'delete':
        mutate(doc, d => { d.highlights = d.highlights.filter(x => x.id !== msg.id); });
        break;
      case 'openSource':
        vscode.window.showTextDocument(vscode.Uri.file(doc), { viewColumn: vscode.ViewColumn.Beside });
        break;
      case 'link': {
        const href = msg.href;
        if (/^https?:/i.test(href)) vscode.env.openExternal(vscode.Uri.parse(href));
        else {
          const [file] = href.split('#');
          const target = path.resolve(path.dirname(doc), decodeURIComponent(file));
          if (target.toLowerCase().endsWith('.md') && fs.existsSync(target)) open(ctx, vscode.Uri.file(target));
          else if (fs.existsSync(target)) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
        }
        break;
      }
    }
    if (['add', 'note', 'kind', 'reply', 'status', 'delete'].includes(msg.type)) {
      sendHighlights(doc);
      refreshAll();
    }
  }, null, disposables);

  panel.onDidDispose(() => {
    disposables.forEach(d => d.dispose());
    panels.delete(doc);
  });
}

// --- Sidebar tree: every highlight in the workspace, grouped by file ---------------------

class Tree {
  constructor() { this._em = new vscode.EventEmitter(); this.onDidChangeTreeData = this._em.event; }
  refresh() { this._em.fire(); }
  entries() {
    const roots = new Set((vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath));
    const out = [];
    for (const r of roots) for (const e of store.all(r)) out.push({ ...e, root: r });
    return out;
  }
  getTreeItem(el) { return el; }
  getChildren(el) {
    if (!el) {
      return this.entries()
        .map(e => ({ ...e, hs: e.data.highlights.filter(h => showResolved || h.status !== 'resolved') }))
        .filter(e => e.hs.length)
        .map(e => {
          const agent = e.hs.filter(h => h.author !== author()).length;
          const it = new vscode.TreeItem(path.relative(e.root, e.doc).replace(/\\/g, '/'), vscode.TreeItemCollapsibleState.Expanded);
          it.description = `${e.hs.length}${agent ? ` · ${agent} from agents` : ''}`;
          it.iconPath = new vscode.ThemeIcon('markdown');
          it.doc = e.doc; it.hs = e.hs;
          return it;
        });
    }
    return el.hs.map(h => {
      const it = new vscode.TreeItem(h.quote.length > 60 ? h.quote.slice(0, 57) + '…' : h.quote);
      it.description = (h.author === author() ? '' : h.author) + (h.status === 'resolved' ? ' · resolved' : '');
      it.tooltip = `${h.kind} · ${h.author}\n“${h.quote}”${h.note ? '\n\n' + h.note : ''}`;
      const icon = { note: ['circle-filled', 'charts.yellow'], question: ['question', 'charts.blue'], issue: ['warning', 'charts.red'], approve: ['check', 'charts.green'] }[h.kind] || ['circle-filled', 'charts.yellow'];
      it.iconPath = new vscode.ThemeIcon(icon[0], new vscode.ThemeColor(icon[1]));
      it.command = { command: 'mdHighlighter.reveal', title: 'Go to highlight', arguments: [el.doc, h.id] };
      return it;
    });
  }
}

function refreshAll() {
  tree && tree.refresh();
  if (!status) return;
  let n = 0;
  for (const f of vscode.workspace.workspaceFolders || []) {
    for (const e of store.all(f.uri.fsPath)) n += e.data.highlights.filter(h => h.status !== 'resolved' && h.author !== author()).length;
  }
  status.text = `$(symbol-color) ${n}`;
  status.tooltip = `${n} open highlight${n === 1 ? '' : 's'} from agents`;
  n ? status.show() : status.hide();
}

function activate(ctx) {
  tree = new Tree();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('mdHighlighter.tree', tree));
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.explorer';
  ctx.subscriptions.push(status);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('mdHighlighter.open', uri => open(ctx, uri)),
    vscode.commands.registerCommand('mdHighlighter.refresh', () => { refreshAll(); for (const d of panels.keys()) sendHighlights(d); }),
    vscode.commands.registerCommand('mdHighlighter.toggleResolved', () => {
      showResolved = !showResolved;
      refreshAll();
      for (const d of panels.keys()) sendHighlights(d);
    }),
    vscode.commands.registerCommand('mdHighlighter.reveal', (doc, id) => open(ctx, vscode.Uri.file(doc), id)),
  );

  // Agents write highlight JSON from outside VS Code: pick those changes up live.
  const watcher = vscode.workspace.createFileSystemWatcher('**/' + store.DIR + '/**/*.json');
  const onStore = uri => {
    refreshAll();
    for (const d of panels.keys()) if (store.storePath(d, rootFor(d)) === uri.fsPath) sendHighlights(d);
  };
  watcher.onDidChange(onStore); watcher.onDidCreate(onStore); watcher.onDidDelete(onStore);
  ctx.subscriptions.push(watcher);
  refreshAll();
}

function deactivate() {}

module.exports = { activate, deactivate };
