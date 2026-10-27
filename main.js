'use strict';

const { Plugin, Modal, Notice, editorInfoField } = require('obsidian');
const { EditorView } = require('@codemirror/view');

// A line made only of 3+ of the same mark: ___  ---  ...  ///  ===  ***  ~~~
const END_RE = /^\s*([_\-.\/=*~])\1{2,}\s*$/;
// "@plan" or "@plan:" alone on its line -> always sent, no question
const AT_RE = /^\s*@([^\s:#\[\]|@][^:#\[\]|@]*?)\s*:?\s*$/;
// "plan:" alone on its line -> sent without asking only for trusted notes
const COLON_RE = /^\s*([^:#\[\]|@]+?)\s*:\s*$/;
const MAX_SCAN = 500; // lines to look back for the header
const DEFAULT_TRUSTED = ['diary'];

function parseHead(text) {
  let m = text.match(AT_RE);
  if (m) return { name: m[1], at: true };
  m = text.match(COLON_RE);
  if (m) return { name: m[1], at: false };
  return null;
}

class ConfirmModal extends Modal {
  constructor(app, name, preview, onPick) {
    super(app);
    this.name = name;
    this.preview = preview;
    this.onPick = onPick;
    this.picked = 'keep';
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `Send to "${this.name}"?` });
    contentEl.createEl('p', { text: this.preview });
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const btn = (text, pick, cta) => {
      const b = row.createEl('button', { text });
      if (cta) b.addClass('mod-cta');
      b.onclick = () => { this.picked = pick; this.close(); };
      return b;
    };
    const send = btn('Send', 'send', true);
    btn(`Always send to "${this.name}"`, 'always');
    btn('Keep here', 'keep');
    send.focus(); // Enter = Send, Esc = Keep here
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

module.exports = class NoteRouterPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    // Notes that "name:" sends to without asking. Grows via "Always send".
    this.trusted = Array.isArray(data.trusted) ? data.trusted : DEFAULT_TRUSTED.slice();

    this.registerEditorExtension(
      EditorView.updateListener.of((update) => this.onUpdate(update))
    );
  }

  onUpdate(update) {
    if (!update.docChanged) return;
    if (!update.transactions.some((tr) => tr.isUserEvent('input'))) return;

    // Find an end-marker line that just got a line break after it.
    const doc = update.state.doc;
    let endLine = 0;
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (endLine || !inserted.toString().includes('\n')) return;
      const a = doc.lineAt(fromB).number;
      const b = doc.lineAt(toB).number;
      for (let n = a; n < b; n++) {
        if (END_RE.test(doc.line(n).text)) { endLine = n; break; }
      }
    });
    if (!endLine) return;

    const info = update.state.field(editorInfoField, false);
    const source = info && info.file;
    if (!source) return;

    const view = update.view;
    // Can't dispatch inside an update listener.
    setTimeout(() => this.route(view, source, endLine), 0);
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
    let headLine = 0;
    let target = null;
    let newName = ''; // "@name" with no note yet -> create it
    let at = false;
    for (let n = endLine - 1; n >= 1 && n >= endLine - MAX_SCAN; n--) {
      const text = doc.line(n).text;
      if (END_RE.test(text)) break; // previous block's end
      const h = parseHead(text);
      if (!h) continue;
      const file = this.findTarget(h.name, source);
      if (file) { headLine = n; target = file; at = h.at; break; }
      if (h.at && !/[*"<>?\\|]/.test(h.name)) { headLine = n; newName = h.name.trim(); at = true; break; }
    }
    if (!target && !newName) return;
    if (target && target.path === source.path) return;

    const lines = [];
    for (let n = headLine + 1; n < endLine; n++) lines.push(doc.line(n).text);
    const content = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!content) return;

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

    // "plan:" for a note not yet trusted -> ask first. "@plan" never asks.
    const key = target.basename.toLowerCase();
    if (!at && !this.trusted.includes(key)) {
      const words = content.replace(/\s+/g, ' ').trim();
      const preview = words.length > 120 ? words.slice(0, 120) + '…' : words;
      const pick = await new Promise((res) =>
        new ConfirmModal(this.app, target.basename, preview, res).open());
      if (pick === 'keep') return;
      if (pick === 'always') {
        this.trusted.push(key);
        await this.saveData({ trusted: this.trusted });
      }
    }
    const headText = doc.line(headLine).text;

    try {
      await this.app.vault.process(target, (text) => addEntry(text, content, new Date()));
    } catch (e) {
      new Notice(`Note Router: could not write to "${target.basename}": ${e.message}`);
      return;
    }

    // Moved: swap the block (header .. end marker) for a one-line link.
    // Re-check it is still where we left it before replacing.
    const d = view.state.doc;
    if (endLine <= d.lines && headLine <= d.lines &&
        END_RE.test(d.line(endLine).text) && d.line(headLine).text === headText) {
      const from = d.line(headLine).from;
      const to = d.line(endLine).to;
      const insert = linkLine(this.app, target, source, content, new Date());
      view.dispatch({
        changes: { from, to, insert },
        // Cursor to the line below the link.
        selection: { anchor: Math.min(from + insert.length + 1, d.length - (to - from) + insert.length) },
        userEvent: 'delete',
      });
    }
    new Notice(newName ? `Created "${target.basename}" and sent` : `Sent to "${target.basename}"`);
  }
};

module.exports.addEntry = addEntry;
