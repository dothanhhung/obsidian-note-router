# Note Router

An Obsidian plugin that files a quick note into another note while you type.

Write the target note's name followed by a colon, your text, and an end line:

```
diary:
Had a great idea about the new app today.
Need to try it this weekend.
___
```

When the end line is finished, the text moves into the note called `diary`, under today's date at the top:

```
27.10.2026
Had a great idea about the new app today.
Need to try it this weekend.

25.10.2026
older entry…
```

It works the same way with any note name: `ideas:`, `work:`, `plan:`…

The end line counts as finished when you press **Enter** after it, move the cursor off it, or stop typing on it for 1.5 seconds. There's also a command, **Note Router: Send the block above the cursor**, to give a hotkey to.

## Two ways to write the name
| You write | What happens |
|---|---|
| `@plan` or `@plan:` | Sent right away, no question. If there is no note called `plan` yet, it is created (in your default folder for new notes). |
| `plan:` | If no note called `plan` exists, a box asks **Create & send** or **Keep here**. If it exists, it is sent right away only if the note is **trusted** (`diary` is trusted from the start). Otherwise a box asks: **Send** (Enter), **Always send to "plan"** (trusts it from now on), or **Keep here** (Esc). |

So a normal line like `Plan:` in the middle of your writing never moves anything without asking. The trusted list is kept in the plugin's `data.json` (`"trusted": ["diary", …]`); delete a name there to be asked again.

## How it behaves
- **End line** = 3 or more of the same mark on its own line: `___`, `---`, `...`, `///`, `===`, `***`, `~~~`.
- **Where a block starts:** the plugin looks up from the end line for the name line, but stops at an earlier end line, a `↪` link line from an earlier send, or 2+ empty lines in a row. A name line beyond that never takes your text.
- **Name matching** ignores case; `folder/name` works too. Lines like `Things to do:` inside your text are skipped when a name line above them matches a note. If nothing matches, the nearest short `name:` line (up to 3 words) is offered for creation (Esc keeps the text where it is).
- **Moved, with a link left behind.** After it is saved in the target, the block in the current note becomes one line pointing to it, e.g. `↪ [[diary]] 27.10.2026 · Had a great idea about the new app…`. Ctrl+Z brings the block back in the current note, but the copy in the target stays.
- **Today's date:** if the target's first line is already today's date (`27.10.2026` or `27.10`), the new entry goes right under it. Otherwise a new date line is added on top. Frontmatter stays first.
- Writing `diary:` inside the diary note itself does nothing.
- Works on desktop and mobile.

Pairs well with [Top Date Stamp](https://github.com/dothanhhung/obsidian-top-date-stamp), which uses the same `dd.mm.yyyy` date.

## Install (manual)
1. In your vault, create the folder `.obsidian/plugins/note-router/`.
2. Copy `main.js` and `manifest.json` from this repo into it.
3. In Obsidian: **Settings → Community plugins**, turn off Restricted mode if needed, then enable **Note Router**.

## Change the date format
Edit `todayStamp()` in `main.js`.

## License
MIT
