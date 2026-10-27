# Note Router

An Obsidian plugin that files a quick note into another note while you type.

Write the target note's name followed by a colon, your text, and an end line:

```
diary:
Had a great idea about the new app today.
Need to try it this weekend.
___
```

Press **Enter** after the end line. The text moves into the note called `diary`, under today's date at the top:

```
27.10.2026
Had a great idea about the new app today.
Need to try it this weekend.

25.10.2026
older entry…
```

It works the same way with any note name: `ideas:`, `work:`, `plan:`…

## Two ways to write the name
| You write | What happens |
|---|---|
| `@plan` or `@plan:` | Sent right away, no question. |
| `plan:` | Sent right away only if the note is **trusted** (`diary` is trusted from the start). Otherwise a box asks: **Send** (Enter), **Always send to "plan"** (trusts it from now on), or **Keep here** (Esc). |

So a normal line like `Plan:` in the middle of your writing never moves anything without asking. The trusted list is kept in the plugin's `data.json` (`"trusted": ["diary", …]`); delete a name there to be asked again.

## How it behaves
- **End line** = 3 or more of the same mark on its own line: `___`, `---`, `...`, `///`, `===`, `***`, `~~~`.
- **The name must match an existing note** (case does not matter; `folder/name` works too). If there is no such note, nothing happens and your text stays where it is. Lines like `Things to do:` inside your text are skipped when no note has that name.
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
