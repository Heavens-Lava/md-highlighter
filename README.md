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
- Keys: **H** / **1–4** highlight the selection, **Ctrl+F** find, **F** focus mode, **Esc** closes popups.
- The **Highlights** view in the Explorer lists marks across the whole workspace; the status bar shows how many open highlights agents left for you.

## What changed since you last read
When you close a document, Markdown Highlighter remembers that version. Next time you open it, anything that changed (for example an agent's edits) is tinted: **green** = added, **amber** = edited, a **red dashed line** = removed text (hover it to see what was removed). The **Changes** tab lists every change with its section; click to jump. **Mark all as read** clears them.

## Checklists
`- [ ]` to-do, `- [x]` done, `- [~]` built/awaiting review and `- [!]` blocked render as coloured status chips. Every heading with checklist items gets a progress bar ("7/11 done · 3 awaiting review"), and the Chapters list shows each section's count.

## Search and reading comfort
- **Ctrl+F** finds in the document (Enter / Shift+Enter to step). The Highlights tab has its own search over quotes, notes and replies.
- **Ctrl+Alt+H** searches every highlight in the workspace.
- Top bar: **A− / A+** text size, **⇔** column width, **◱** focus mode (or press **F**), a reading-progress line and time left. Click the ▾ next to a heading to collapse its section.

## Export
**Export** in the Highlights tab (or *Markdown Highlighter: Export Highlights…*) copies highlights as a Markdown summary, as a **task list to paste to an agent**, or saves them to a file.

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
