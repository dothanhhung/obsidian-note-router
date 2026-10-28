'use strict';

const { Plugin, Modal, SuggestModal, Notice, editorInfoField } = require('obsidian');
const { EditorView } = require('@codemirror/view');

// A line made only of 3+ of the same mark: ___  ---  ...  ///  ===  ***  ~~~
const END_RE = /^\s*([_\-.\/=*~])\1{2,}\s*$/;
// The only two header forms, alone on their line (note created if missing):
//   "@Note name:" (colon optional)   and   "Note name::"
// A plain "name:" line is ordinary text and never sends anything.
const AT_RE = /^\s*@([^\s:#\[\]|@][^:#\[\]|@]*?)\s*:?\s*$/;
const DOUBLE_RE = /^\s*([^:#\[\]|@]+?)\s*::\s*$/;
// Left behind by an earlier send: "↪ [[x]] …" or the "> [!sent] ↪ [[x]] …" callout.
const LINK_RE = /^\s*(>\s*\[!sent\][+-]?\s*)?↪ /;
const QUOTE_RE = /^\s*>/; // any quote / callout line also ends a block
const MAX_SCAN = 500; // lines to look back for the header

function parseHead(text) {
  const m = text.match(AT_RE) || text.match(DOUBLE_RE);
  return m ? m[1].trim() : null;
}

// The window an element lives in (Obsidian pop-out windows have their own).
function activeWindowOf(el) {
  return (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
}

// One question per send: just a link, or keep the text (small) under a link.
class SendModal extends Modal {
  // create = true: the note does not exist yet.
  constructor(app, name, preview, create, onPick) {
    super(app);
    this.name = name;
    this.preview = preview;
    this.create = create;
    this.onPick = onPick;
    this.picked = { mode: 'cancel', remember: false };
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', {
      text: this.create ? `Create note "${this.name}" and send?` : `Send to "${this.name}"?`,
    });
    contentEl.createEl('p', { text: this.preview });

    const lab = contentEl.createEl('label');
    const box = lab.createEl('input');
    box.type = 'checkbox';
    lab.appendText(` Remember for "${this.name}" (don't ask again)`);

    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    // One way out, whichever path (button, key, Esc) gets there first.
    this.pick = (mode) => {
      if (this.done) return;
      this.done = true;
      this.picked = { mode, remember: box.checked };
      this.close();
    };
    const btn = (text, mode, cta) => {
      const b = row.createEl('button', { text });
      if (cta) b.addClass('mod-cta');
      b.addEventListener('click', () => this.pick(mode));
      return b;
    };
    const first = btn('Just link (J)', 'link', true);
    btn('Keep text, small (K)', 'keep');
    btn('Nothing (N)', 'none');
    btn('Cancel', 'cancel');
    first.focus(); // Enter = Just link, Esc = Cancel

    // J = just link, K = keep text, N = leave nothing behind. Read the physical
    // key (e.code): with a Vietnamese input tool or another layout, e.key can be
    // "Process" or a different letter.
    const KEYS = { KeyJ: 'link', KeyK: 'keep', KeyN: 'none' };
    this.onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const mode = KEYS[e.code] || { j: 'link', k: 'keep', n: 'none' }[(e.key || '').toLowerCase()];
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      this.pick(mode);
    };
    // Caught on the window first (before Obsidian's own key handling), and
    // through the modal's key scope as a second route.
    this.keyWin = activeWindowOf(this.modalEl || this.contentEl);
    this.keyWin.addEventListener('keydown', this.onKey, true);
    if (this.scope && this.scope.register) {
      for (const k of ['j', 'k', 'n', 'J', 'K', 'N']) {
        this.scope.register([], k, (e) => { this.onKey(e); return false; });
      }
    }
  }
  onClose() {
    if (this.keyWin) this.keyWin.removeEventListener('keydown', this.onKey, true);
    this.contentEl.empty();
    this.onPick(this.picked);
  }
}

// "Move this to…": type to find a note, or pick "Create …" for a new one.
// Resolves { file } or { create: name }, or null when closed.
class NotePicker extends SuggestModal {
  constructor(app, source, onPick) {
    super(app);
    this.source = source;
    this.onPick = onPick;
    this.setPlaceholder('Move this to… (type a note name)');
  }
  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path !== this.source.path && (!q || f.basename.toLowerCase().includes(q)))
      .sort((a, b) => {
        // Exact and prefix matches first, then most recently edited.
        const rank = (f) => (f.basename.toLowerCase() === q ? 0 : f.basename.toLowerCase().startsWith(q) ? 1 : 2);
        return rank(a) - rank(b) || (b.stat ? b.stat.mtime : 0) - (a.stat ? a.stat.mtime : 0);
      })
      .slice(0, 50)
      .map((file) => ({ file }));
    const exact = files.some((s) => s.file.basename.toLowerCase() === q);
    return q && !exact ? [...files, { create: query.trim() }] : files;
  }
  renderSuggestion(s, el) {
    if (s.file) {
      el.createEl('div', { text: s.file.basename });
      if (s.file.parent && s.file.parent.path !== '/') el.createEl('small', { text: s.file.parent.path });
    } else {
      el.createEl('div', { text: `Create "${s.create}"` });
    }
  }
  onChooseSuggestion(s) {
    this.chosen = true;
    this.onPick(s);
  }
  onClose() {
    // Obsidian closes the picker before calling onChooseSuggestion.
    setTimeout(() => { if (!this.chosen) this.onPick(null); }, 0);
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function todayStamp(d) { return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
function isTodayLine(line, d) {
  const t = line.trim();
  const short = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  const bare = `${d.getDate()}.${d.getMonth() + 1}`;
  return t === todayStamp(d) || t === short || t === bare;
}

// Insert `content` into `text` under today's date, newest on top.
function addEntry(text, content, now) {
  let head = '';
  let body = text;
  // Keep frontmatter on top.
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (fm) { head = fm[0]; body = text.slice(fm[0].length); }

  const lead = body.match(/^\s*/)[0];
  const rest = body.slice(lead.length);
  const nl = rest.indexOf('\n');
  const first = nl === -1 ? rest : rest.slice(0, nl);

  if (rest && isTodayLine(first, now)) {
    // Today's date already on top: put the new entry right under it.
    const after = nl === -1 ? '' : rest.slice(nl + 1).replace(/^\s*\n/, '');
    return head + lead + first + '\n' + content + '\n\n' + after;
  }
  return head + todayStamp(now) + '\n' + content + '\n\n' + rest;
}

// What stays behind in the source note: "↪ [[diary]] 27.10.2026 · today I feel…"
function linkLine(app, target, source, content, now) {
  const link = app.fileManager.generateMarkdownLink(target, source.path);
  const words = content.replace(/\s+/g, ' ').trim();
  const preview = words.length > 40 ? words.slice(0, 40).trimEnd() + '…' : words;
  return `↪ ${link} ${todayStamp(now)} · ${preview}`;
}

// "Keep text": the text stays, small and dimmed (styles.css), under the link.
//   > [!sent] ↪ [[diary]] 27.10.2026
//   > today I feel…
function keptBlock(app, target, source, content, now) {
  const link = app.fileManager.generateMarkdownLink(target, source.path);
  const body = content.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
  return `> [!sent] ↪ ${link} ${todayStamp(now)}\n${body}`;
}

module.exports = class NoteRouterPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    // note name (lower case) -> 'link' | 'keep', set by "Remember for …"
    this.remember = data.remember && typeof data.remember === 'object' ? data.remember : {};

    this.pending = null; // { view, source, line, timer } - end line typed, not yet sent
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => this.onUpdate(update))
    );
    this.register(() => this.cancelPending());
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, mdView) =>
      this.onEditorMenu(menu, editor, mdView)));

    this.addCommand({
      id: 'send-block',
      name: 'Send the block above the cursor',
      editorCallback: (editor, ctx) => {
        const view = editor.cm;
        if (!view || !ctx.file) return;
        const doc = view.state.doc;
        // Nearest end line at or below the cursor.
        for (let n = doc.lineAt(view.state.selection.main.head).number; n <= doc.lines; n++) {
          if (END_RE.test(doc.line(n).text)) { this.route(view, ctx.file, n); return; }
        }
        new Notice('Note Router: no ___ / --- / ... end line below the cursor');
      },
    });
  }

  cancelPending() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  // Send when the end line is finished: Enter after it, the cursor leaving it,
  // or 1.5 s without typing on it.
  onUpdate(update) {
    const view = update.view;
    const p = this.pending;
    if (p && p.view === view && (update.docChanged || update.selectionSet)) {
      const head = update.state.selection.main.head;
      const onLine = p.line <= update.state.doc.lines &&
        update.state.doc.lineAt(head).number === p.line;
      if (!onLine) {
        this.cancelPending();
        setTimeout(() => this.route(view, p.source, p.line), 0);
        return;
      }
      if (update.docChanged) this.cancelPending(); // still typing on it; re-armed below
    }

    if (!update.docChanged) return;
    if (!update.transactions.some((tr) => tr.isUserEvent('input'))) return;

    const info = update.state.field(editorInfoField, false);
    const source = info && info.file;
    if (!source) return;
    const doc = update.state.doc;

    // An end line that just got a line break after it (Enter, paste): send now.
    let endLine = 0;
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (endLine || !inserted.toString().includes('\n')) return;
      const a = doc.lineAt(fromB).number;
      const b = doc.lineAt(toB).number;
      for (let n = a; n < b; n++) {
        if (END_RE.test(doc.line(n).text)) { endLine = n; break; }
      }
    });
    if (endLine) {
      // Can't dispatch inside an update listener.
      setTimeout(() => this.route(view, source, endLine), 0);
      return;
    }

    // Typing on an end line: wait for a pause.
    const line = doc.lineAt(update.state.selection.main.head);
    if (END_RE.test(line.text)) {
      this.cancelPending();
      const pend = { view, source, line: line.number };
      pend.timer = setTimeout(() => {
        if (this.pending !== pend) return;
        this.pending = null;
        this.route(view, source, pend.line);
      }, 1500);
      this.pending = pend;
    }
  }

  findTarget(name, source) {
    const byLink = this.app.metadataCache.getFirstLinkpathDest(name, source.path);
    if (byLink && byLink.extension === 'md') return byLink;
    const lower = name.toLowerCase();
    return this.app.vault.getMarkdownFiles().find((f) => f.basename.toLowerCase() === lower) || null;
  }

  async route(view, source, endLine) {
    const doc = view.state.doc;
    if (endLine > doc.lines || !END_RE.test(doc.line(endLine).text)) return;

    // Walk up to the nearest header line; it names the note (created if missing).
    let headLine = 0;
    let target = null;
    let newName = ''; // no note yet -> create it
    // The block ends (going up) at an earlier end line, a link / callout left by
    // an earlier send, any quote line, or 2+ empty lines in a row.
    let blanks = 0;
    for (let n = endLine - 1; n >= 1 && n >= endLine - MAX_SCAN; n--) {
      const text = doc.line(n).text;
      if (END_RE.test(text) || LINK_RE.test(text) || QUOTE_RE.test(text)) break;
      if (!text.trim()) { if (++blanks >= 2) break; continue; }
      blanks = 0;
      const name = parseHead(text);
      if (!name) continue;
      headLine = n;
      target = this.findTarget(name, source);
      if (!target) newName = name;
      break;
    }
    if (!target && !newName) return;
    if (newName && /[*"<>?\\|]/.test(newName)) {
      new Notice(`Note Router: "${newName}" can't be a note name`);
      return;
    }
    if (target && target.path === source.path) return;

    const lines = [];
    for (let n = headLine + 1; n < endLine; n++) lines.push(doc.line(n).text);
    const content = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!content) return;
    return this.send(view, source, {
      from: doc.line(headLine).from, to: doc.line(endLine).to, target, newName, content,
    });
  }

  // Right-click on a selection: "Move to <name>" when it starts with a header
  // line, otherwise "Move this to…" with a note picker.
  onEditorMenu(menu, editor, mdView) {
    const view = editor && editor.cm;
    const source = mdView && mdView.file;
    if (!view || !source) return;
    const sel = this.selectedLines(view);
    if (!sel) return;
    const head = parseHead(sel.firstLine);
    menu.addItem((item) => item
      .setTitle(head ? `Move to "${head.split('/').pop()}"` : 'Move this to…')
      .setIcon('corner-up-right')
      .onClick(() => this.moveSelection(view, source)));
  }

  // The selection grown to whole lines, or null when nothing is selected.
  selectedLines(view) {
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    const doc = view.state.doc;
    const first = doc.lineAt(from);
    let last = doc.lineAt(to);
    if (to === last.from && last.number > first.number) last = doc.line(last.number - 1);
    const text = doc.sliceString(first.from, last.to);
    if (!text.trim()) return null;
    return { from: first.from, to: last.to, text, firstLine: first.text };
  }

  async moveSelection(view, source) {
    const sel = this.selectedLines(view);
    if (!sel) return;
    let lines = sel.text.split('\n');
    let target = null;
    let newName = '';
    const head = parseHead(lines[0]);
    if (head) {
      lines = lines.slice(1);
      target = this.findTarget(head, source);
      if (!target) newName = head;
    } else {
      const pick = await new Promise((res) => new NotePicker(this.app, source, res).open());
      if (!pick) return;
      if (pick.file) target = pick.file; else newName = pick.create;
    }
    // An end line at the bottom of the selection is not content.
    if (lines.length && END_RE.test(lines[lines.length - 1])) lines = lines.slice(0, -1);
    const content = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!content) { new Notice('Note Router: nothing to move'); return; }
    if (newName && /[*"<>?\\|]/.test(newName)) {
      new Notice(`Note Router: "${newName}" can't be a note name`);
      return;
    }
    if (target && target.path === source.path) { new Notice('Note Router: that is this note'); return; }
    return this.send(view, source, { from: sel.from, to: sel.to, target, newName, content });
  }

  // Ask how to leave it, write it into the target under today's date, then
  // replace source [from, to] with the link, the small kept text, or nothing.
  async send(view, source, { from, to, target, newName, content }) {
    const original = view.state.doc.sliceString(from, to);

    // Ask: just a link, or keep the text small? Skipped when remembered for this note.
    const name = target ? target.basename : newName.split('/').pop();
    const key = name.toLowerCase();
    let mode = target ? this.remember[key] : null;
    if (mode !== 'link' && mode !== 'keep' && mode !== 'none') {
      const words = content.replace(/\s+/g, ' ').trim();
      const preview = words.length > 120 ? words.slice(0, 120) + '…' : words;
      const pick = await new Promise((res) =>
        new SendModal(this.app, name, preview, !!newName, res).open());
      if (pick.mode === 'cancel') return;
      mode = pick.mode;
      if (pick.remember) {
        this.remember[key] = mode;
        await this.saveData({ remember: this.remember });
      }
    }

    if (newName) {
      // New note goes where Obsidian puts new notes ("folder/name" keeps its folder).
      const parent = newName.includes('/') ? null : this.app.fileManager.getNewFileParent(source.path);
      const path = parent && parent.path !== '/' ? `${parent.path}/${newName}.md` : `${newName}.md`;
      try {
        target = await this.app.vault.create(path, '');
      } catch (e) {
        new Notice(`Note Router: could not create "${newName}": ${e.message}`);
        return;
      }
    }

    try {
      await this.app.vault.process(target, (text) => addEntry(text, content, new Date()));
    } catch (e) {
      new Notice(`Note Router: could not write to "${target.basename}": ${e.message}`);
      return;
    }

    // Swap the block for the link, the small kept text, or nothing at all.
    // Only if it is still exactly where we left it.
    const d = view.state.doc;
    if (to <= d.length && d.sliceString(from, to) === original) {
      if (mode === 'none') {
        // Remove the block and its line break; cursor where the block was.
        const end = d.sliceString(to, to + 1) === '\n' ? to + 1 : to;
        view.dispatch({ changes: { from, to: end, insert: '' }, selection: { anchor: from }, userEvent: 'delete' });
      } else {
        const insert = mode === 'keep'
          ? keptBlock(this.app, target, source, content, new Date())
          : linkLine(this.app, target, source, content, new Date());
        view.dispatch({
          changes: { from, to, insert },
          // Cursor to the line below the link.
          selection: { anchor: Math.min(from + insert.length + 1, d.length - (to - from) + insert.length) },
          userEvent: 'delete',
        });
      }
    } else {
      new Notice('Note Router: sent, but the text changed meanwhile, so it was left in place');
    }
    view.focus(); // back to writing after the box closes
    new Notice(newName ? `Created "${target.basename}" and sent` : `Sent to "${target.basename}"`);
  }
};

module.exports.addEntry = addEntry;
