'use strict';

const { Plugin, Modal, Notice, editorInfoField } = require('obsidian');
const { EditorView } = require('@codemirror/view');

// A line made only of 3+ of the same mark: ___  ---  ...  ///  ===  ***  ~~~
const END_RE = /^\s*([_\-.\/=*~])\1{2,}\s*$/;
// "@plan" or "@plan:" alone on its line -> any note name, created if missing
const AT_RE = /^\s*@([^\s:#\[\]|@][^:#\[\]|@]*?)\s*:?\s*$/;
// "plan:" alone on its line
const COLON_RE = /^\s*([^:#\[\]|@]+?)\s*:\s*$/;
// Left behind by an earlier send: "↪ [[x]] …" or the "> [!sent] ↪ [[x]] …" callout.
const LINK_RE = /^\s*(>\s*\[!sent\][+-]?\s*)?↪ /;
const QUOTE_RE = /^\s*>/; // any quote / callout line also ends a block
const MAX_SCAN = 500; // lines to look back for the header

function parseHead(text) {
  let m = text.match(AT_RE);
  if (m) return { name: m[1], at: true };
  m = text.match(COLON_RE);
  if (m) return { name: m[1], at: false };
  return null;
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
    const btn = (text, mode, cta) => {
      const b = row.createEl('button', { text });
      if (cta) b.addClass('mod-cta');
      b.onclick = () => { this.picked = { mode, remember: box.checked }; this.close(); };
      return b;
    };
    const first = btn('Just link', 'link', true);
    btn('Keep text (small)', 'keep');
    btn('Cancel', 'cancel');
    first.focus(); // Enter = Just link, Esc = Cancel
  }
  onClose() {
    this.contentEl.empty();
    this.onPick(this.picked);
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

    // Walk up to the nearest "@name" line, or "name:" line whose note exists.
    // Remember the nearest "name:" with no note, in case nothing else matches.
    const badName = (s) => /[*"<>?\\|]/.test(s);
    let headLine = 0;
    let target = null;
    let newName = ''; // no note yet -> create it
    let at = false;
    let loose = null;
    // The block ends (going up) at an earlier end line, a link / callout left by
    // an earlier send, any quote line, or 2+ empty lines in a row.
    let blanks = 0;
    for (let n = endLine - 1; n >= 1 && n >= endLine - MAX_SCAN; n--) {
      const text = doc.line(n).text;
      if (END_RE.test(text) || LINK_RE.test(text) || QUOTE_RE.test(text)) break;
      if (!text.trim()) { if (++blanks >= 2) break; continue; }
      blanks = 0;
      const h = parseHead(text);
      if (!h) continue;
      const file = this.findTarget(h.name, source);
      if (file) { headLine = n; target = file; at = h.at; break; }
      if (badName(h.name)) continue;
      if (h.at) { headLine = n; newName = h.name.trim(); at = true; break; }
      // Offer to create only short names (a sentence ending in ":" is not a note name).
      if (!loose && h.name.trim().split(/\s+/).length <= 3) loose = { n, name: h.name.trim() };
    }
    if (!target && !newName && loose) { headLine = loose.n; newName = loose.name; }
    if (!target && !newName) return;
    if (target && target.path === source.path) return;

    const lines = [];
    for (let n = headLine + 1; n < endLine; n++) lines.push(doc.line(n).text);
    const content = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!content) return;
    const headText = doc.line(headLine).text;

    // Ask: just a link, or keep the text small? Skipped when remembered for this note.
    const name = target ? target.basename : newName.split('/').pop();
    const key = name.toLowerCase();
    let mode = target ? this.remember[key] : null;
    if (mode !== 'link' && mode !== 'keep') {
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

    // Swap the block (header .. end marker) for the link, or the small kept text.
    // Re-check it is still where we left it before replacing.
    const d = view.state.doc;
    if (endLine <= d.lines && headLine <= d.lines &&
        END_RE.test(d.line(endLine).text) && d.line(headLine).text === headText) {
      const from = d.line(headLine).from;
      const to = d.line(endLine).to;
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
    view.focus(); // back to writing after the box closes
    new Notice(newName ? `Created "${target.basename}" and sent` : `Sent to "${target.basename}"`);
  }
};

module.exports.addEntry = addEntry;
