# Note Router

An Obsidian plugin that files a quick note into another note while you type.

Write the target note's name, your text, and an end line:

```
diary::
Had a great idea about the new app today.
Need to try it this weekend.
___
```

When the end line is finished, a small box asks what to leave behind, and the text moves into the note called `diary`, under today's date at the top:

```
27.10.2026
Had a great idea about the new app today.
Need to try it this weekend.

25.10.2026
older entry…
```

It works the same way with any note name: `ideas::`, `@Big Plan:`…

The end line counts as finished when you press **Enter** after it, move the cursor off it, or stop typing on it for 1.5 seconds. There's also a command, **Note Router: Send the block above the cursor**, that you can bind to a hotkey.

## Right-click a selection
Select some lines and right-click:
- If the selection starts with a header line (`@Note name:` or `Note name::`), the menu shows **Move to "Note name"**. No end line needed.
- Otherwise it shows **Move this to…**, which opens a note picker: type to find a note, or pick **Create "…"** to make a new one.

The selection is taken as whole lines. Then the same box below appears.

## The box
| Button | What stays in the current note |
|---|---|
| **Just link** (J or Enter) | One line: `↪ [[diary]] 27.10.2026 · Had a great idea about the new app…` |
| **Keep text, small** (K) | The text, small and dimmed, under the link (a `> [!sent]` callout, styled by `styles.css`) |
| **Nothing** (N) | Nothing; the block is simply gone from this note (it's in the target) |
| **Cancel** (Esc) | Not sent; your text stays as you typed it |

Tick **Remember for "diary"** to skip the box for that note from then on (it always uses the choice you made). The remembered choices are in the plugin's `data.json` (`"remember": {"diary": "link"}`); delete a name there to be asked again.

## Writing the name
Only two forms, each alone on its line:
- `@Note name:` (the colon is optional)
- `Note name::`

A plain `name:` line is ordinary text and never sends anything, so lines like `Things to do:` in your writing are safe. If the note doesn't exist yet, the box says **Create note "Note name" and send?** and creates it in your default folder for new notes.

## How it behaves
- **End line** = 3 or more of the same mark on its own line: `___`, `---`, `...`, `///`, `===`, `***`, `~~~`.
- **Where a block starts:** the plugin looks up from the end line for the name line, but stops at an earlier end line, a link or callout left by an earlier send, any `>` quote line, or 2+ empty lines in a row. A name line beyond that never takes your text.
- **Name matching** ignores case; `folder/name` works too.
- **Today's date:** if the target's first line is already today's date (`27.10.2026` or `27.10`), the new entry goes right under it. Otherwise a new date line is added on top. Frontmatter stays first.
- Ctrl+Z brings the block back in the current note, but the copy in the target stays.
- Writing `diary::` inside the diary note itself does nothing.
- Works on desktop and mobile.

Pairs well with [Top Date Stamp](https://github.com/dothanhhung/obsidian-top-date-stamp), which uses the same `dd.mm.yyyy` date.

## Install (manual)
1. In your vault, create the folder `.obsidian/plugins/note-router/`.
2. Copy `main.js`, `manifest.json` and `styles.css` from this repo into it.
3. In Obsidian: **Settings → Community plugins**, turn off Restricted mode if needed, then enable **Note Router**.

## Change the date format
Edit `todayStamp()` in `main.js`.

## License
MIT
