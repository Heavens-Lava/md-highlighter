// Markdown Highlighter — VS Code extension host.
// Renders a Markdown file in a webview reader where you can highlight while you read,
// jump by chapter or highlight, and see highlights agents left for you.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const baseline = require('./lib/baseline');
const actions = require('./lib/actions');

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

// --- "what changed since you last read": per-doc snapshot taken when you finish reading ----

function render(doc, webview) {
  return actions.view(doc, src => webview.asWebviewUri(vscode.Uri.file(path.resolve(path.dirname(doc), decodeURIComponent(src)))).toString());
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
  <div id="tabs"><button data-tab="toc" class="on">Chapters</button><button data-tab="hl">Highlights <span id="hlcount"></span></button><button data-tab="chg">Changes <span id="chgcount"></span></button></div>
  <nav id="toc"></nav>
  <div id="hl" hidden></div>
  <div id="chg" hidden></div>
</aside>
<main id="main"><div id="bar"><span id="docname">${path.basename(doc)}</span><span id="agentnote"></span><span id="chgnote"></span>
  <span id="find" hidden><input id="findq" placeholder="Find in document" spellcheck="false"><span id="findn"></span><button id="findprev" title="Previous (Shift+Enter)">↑</button><button id="findnext" title="Next (Enter)">↓</button><button id="findx" title="Close (Esc)">✕</button></span>
  <span class="tools"><button id="findbtn" title="Find (Ctrl+F)">⌕</button><button id="smaller" title="Smaller text">A−</button><button id="bigger" title="Larger text">A+</button><button id="width" title="Column width">⇔</button><button id="focusbtn" title="Focus mode (F)">◱</button><button id="src" title="Open the source file">Source</button></span>
  <div id="progress"><div></div></div><span id="timeleft"></span></div><article id="doc"></article></main>
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

function send(doc, extra = {}) {
  const p = panels.get(doc);
  if (!p) return;
  const r = render(doc, p.panel.webview);
  p.panel.webview.postMessage({ type: 'render', ...r, highlights: highlightsFor(doc), me: author(), showResolved, prefs: p.prefs(), ...extra });
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
  const entry = { panel, disposables, pendingFocus: focusId, prefs: () => ctx.globalState.get('prefs', {}) };
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
      case 'markRead':
        baseline.save(doc);
        send(doc, { keepScroll: true });
        break;
      case 'prefs':
        ctx.globalState.update('prefs', msg.prefs);
        break;
      case 'export':
        vscode.commands.executeCommand('mdHighlighter.export', doc);
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
    if (actions.apply(doc, rootFor(doc), msg, author())) {
      sendHighlights(doc);
      refreshAll();
    }
  }, null, disposables);

  panel.onDidDispose(() => {
    try { baseline.save(doc); } catch { /* file may have been deleted */ } // you've read this version now
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

// --- search + export -----------------------------------------------------------------------------

function everyHighlight() {
  const out = [];
  for (const f of vscode.workspace.workspaceFolders || []) {
    for (const e of store.all(f.uri.fsPath)) for (const h of e.data.highlights) out.push({ doc: e.doc, root: f.uri.fsPath, h });
  }
  return out;
}

async function searchHighlights(ctx) {
  const KIND = { note: '$(circle-filled)', question: '$(question)', issue: '$(warning)', approve: '$(check)' };
  const items = everyHighlight().map(({ doc, root, h }) => ({
    label: `${KIND[h.kind] || ''} ${h.quote.length > 90 ? h.quote.slice(0, 87) + '…' : h.quote}`,
    description: path.relative(root, doc).split(path.sep).join('/') + (h.author !== author() ? ` · ${h.author}` : '') + (h.status === 'resolved' ? ' · resolved' : ''),
    detail: [h.note, ...(h.replies || []).map(r => `${r.author}: ${r.text}`)].filter(Boolean).join('  ·  ') || undefined,
    doc, id: h.id,
  }));
  if (!items.length) return vscode.window.showInformationMessage('No highlights in this workspace yet.');
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Search highlights and notes across the workspace', matchOnDescription: true, matchOnDetail: true });
  if (pick) open(ctx, vscode.Uri.file(pick.doc), pick.id);
}

async function exportHighlights(doc) {
  doc = doc || [...panels.keys()].pop() || vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!doc) return vscode.window.showWarningMessage('Open a Markdown file with highlights first.');
  const all = highlightsFor(doc);
  const which = await vscode.window.showQuickPick([
    { label: 'Open highlights', filter: h => h.status !== 'resolved' },
    { label: 'Only issues and questions (open)', filter: h => h.status !== 'resolved' && (h.kind === 'issue' || h.kind === 'question') },
    { label: 'Everything, including resolved', filter: () => true },
  ], { placeHolder: `Export which highlights from ${path.basename(doc)}?` });
  if (!which) return;
  const hs = all.filter(which.filter);
  if (!hs.length) return vscode.window.showInformationMessage('No highlights match.');
  const how = await vscode.window.showQuickPick([
    { label: '$(clippy) Copy as Markdown summary', id: 'copy' },
    { label: '$(hubot) Copy as a task list for an agent', id: 'tasks' },
    { label: '$(save) Save as a Markdown file…', id: 'save' },
  ], { placeHolder: `${hs.length} highlight${hs.length === 1 ? '' : 's'}` });
  if (!how) return;
  const text = actions.exportText(doc, rootFor(doc), hs, author(), how.id === 'tasks');
  if (how.id === 'save') {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(doc.replace(/\.md$/i, '') + '.highlights.md'), filters: { Markdown: ['md'] } });
    if (target) { fs.writeFileSync(target.fsPath, text); vscode.window.showInformationMessage('Saved ' + path.basename(target.fsPath)); }
  } else {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(how.id === 'tasks' ? 'Copied — paste it to your agent.' : 'Copied highlights as Markdown.');
  }
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
    vscode.commands.registerCommand('mdHighlighter.search', () => searchHighlights(ctx)),
    vscode.commands.registerCommand('mdHighlighter.export', doc => exportHighlights(typeof doc === 'string' ? doc : doc && doc.fsPath)),
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
