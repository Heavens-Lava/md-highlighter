# Markdown Highlighter

<!-- TODO: add docs/screenshot.png taken from the extension running in VS Code -->

Read Markdown files rendered, mark important passages without breaking your reading flow, and jump back to them later. Agents can leave highlights for you too, and read yours.

## Reading
- Open any `.md` â†’ click the **âœŽ colour icon** in the editor title bar (or right-click the file â†’ **Open with Highlighter**).
- **Highlight:** select text, then click a colour (or press **H** / **1â€“4**). That's it: keep reading.
  - yellow = highlight Â· blue = question Â· red = issue Â· green = good
- **Come back later:** the left panel has **Chapters** (headings; your current section is lit) and **Highlights** (every mark in reading order). The rail on the right shows where the marks sit; click a tick to jump.
- Click a highlight to add a note, change its colour, reply, resolve or delete it.
- Your scroll position is remembered per document.
- Keys: **H** / **1â€“4** highlight the selection, **Ctrl+F** find, **F** focus mode, **Esc** closes popups.
- The **Highlights** view in the Explorer lists marks across the whole workspace; the status bar shows how many open highlights agents left for you.

## What changed since you last read
When you close a document (in VS Code or the browser), Markdown Highlighter remembers that version in `~/.md-highlighter/`. Next time you open it, anything that changed (for example an agent's edits) is tinted: **green** = added, **amber** = edited, a **red dashed line** = removed text (hover it to see what was removed). The **Changes** tab lists every change with its section; click to jump. **Mark all as read** clears them.

## Checklists
`- [ ]` to-do, `- [x]` done, `- [~]` built/awaiting review and `- [!]` blocked render as coloured status chips. Every heading with checklist items gets a progress bar ("7/11 done Â· 3 awaiting review"), and the Chapters list shows each section's count.

## Search and reading comfort
- **Ctrl+F** finds in the document (Enter / Shift+Enter to step). The Highlights tab has its own search over quotes, notes and replies.
- **Ctrl+Alt+H** searches every highlight in the workspace.
- Top bar: **Aâˆ’ / A+** text size, **â‡”** column width, **â—±** focus mode (or press **F**), a reading-progress line and time left. Click the â–¾ next to a heading to collapse its section.

## Export
**Export** in the Highlights tab (or *Markdown Highlighter: Export Highlightsâ€¦*) copies highlights as a Markdown summary, as a **task list to paste to an agent**, or saves them to a file.

## Read in a web browser
The same reader runs in any browser, sharing highlights and "last read" state with VS Code and your agents:
- **From VS Code:** click **⇱** in the reader's toolbar, the globe icon in the editor title bar, or right-click a `.md` file → **Open in Web Browser**. VS Code starts the web reader in the background (port 4747, or the next free one) and opens that document.
- **From a terminal:**
```
mdhl serve [folder]      # opens http://localhost:4747 (keep the terminal open; Ctrl+C stops it)
```
- A file list of every `.md` in the folder, with badges for highlights, agent highlights and "updated since you read it". Type to filter.
- Highlights, notes and "Mark as read" save to the same `.highlights/` files, and edits from VS Code or an agent show up live without refreshing.
- **Edit** opens the document in VS Code. Leaving the page counts as reading it.
- `--port N` picks another port. `--lan` also serves it to your phone or tablet on the same Wi-Fi; the printed link carries a secret token, and anyone with that link on your network can read and highlight.
- It only serves Markdown and images from inside the folder you point it at.

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

## Install the `mdhl` command
From this folder run `npm link` once; then `mdhl` works in any terminal (`mdhl serve`, `mdhl list --open`, …). Without it, use `node <path-to>/md-highlighter/bin/mdhl.js`.

## Build / install
```
npm install
npx vsce package
code --install-extension md-highlighter-0.1.0.vsix
```
