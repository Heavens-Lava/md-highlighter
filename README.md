# Markdown Highlighter

<!-- TODO: add docs/screenshot.png taken from the extension running in VS Code -->

Read Markdown files rendered, mark important passages without breaking your reading flow, and jump back to them later. Agents can leave highlights for you too, and read yours.

## Reading
- Open any `.md` → click the **✎ colour icon** in the editor title bar (or right-click the file → **Open with Highlighter**).
- **Highlight:** select text, then click a colour (or press **H** / **1–4**). That's it: keep reading.
  - yellow = highlight · blue = question · red = issue · green = good
- **Come back later:** the left panel has **Chapters** (headings; your current section is lit) and **Highlights** (every mark in reading order). The rail on the right shows where the marks sit; click a tick to jump.
- Click a highlight to add a note, change its colour, reply, resolve or delete it.
- Your scroll position is remembered per document.
- The **Highlights** view in the Explorer lists marks across the whole workspace; the status bar shows how many open highlights agents left for you.

## Storage
Highlights for `<root>/path/doc.md` live in `<root>/.highlights/path/doc.md.json`. Each highlight is anchored by its quoted text (plus a little context), so it survives edits to the document. If the text is later deleted, the highlight is listed as "text changed: not found".

## For agents (`mdhl` CLI)
```
node <path-to>/md-highlighter/bin/mdhl.js <command>
  add <doc.md> --quote "exact phrase" [--kind note|question|issue|approve] [--note "why"]
  list [doc.md] [--open] [--author You] [--json]      # what the human marked for you
  reply <doc.md> <id> "text"
  resolve <doc.md> <id> | reopen <doc.md> <id>
```
Author comes from `--author`, `$MDHL_AUTHOR`, or `$INVENTOR_AGENT`. Quotes are matched with Markdown syntax stripped; keep them short and unique. `add` refuses quotes that aren't in the document.

## Build / install
```
npm install
npx vsce package --allow-missing-repository --skip-license
code --install-extension md-highlighter-0.1.0.vsix
```
