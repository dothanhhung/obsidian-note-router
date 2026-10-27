'use strict';

const { Plugin, Notice, editorInfoField } = require('obsidian');
const { EditorView } = require('@codemirror/view');

// A line made only of 3+ of the same mark: ___  ---  ...  ///  ===  ***  ~~~
const END_RE = /^\s*([_\-.\/=*~])\1{2,}\s*$/;
// "diary:" alone on its line
const HEAD_RE = /^\s*([^:#\[\]|]+?)\s*:\s*$/;
const MAX_SCAN = 500; // lines to look back for the header

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

module.exports = class NoteRouterPlugin extends Plugin {
  async onload() {
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

    // Walk up to the nearest "name:" line whose name is an existing note.
    let headLine = 0;
    let target = null;
    for (let n = endLine - 1; n >= 1 && n >= endLine - MAX_SCAN; n--) {
      const text = doc.line(n).text;
      if (END_RE.test(text)) break; // previous block's end
      const m = text.match(HEAD_RE);
      if (!m) continue;
      const file = this.findTarget(m[1], source);
      if (file) { headLine = n; target = file; break; }
    }
    if (!target || target.path === source.path) return;

    const lines = [];
    for (let n = headLine + 1; n < endLine; n++) lines.push(doc.line(n).text);
    const content = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!content) return;

    try {
      await this.app.vault.process(target, (text) => addEntry(text, content, new Date()));
    } catch (e) {
      new Notice(`Note Router: could not write to "${target.basename}": ${e.message}`);
      return;
    }

    // Moved: remove the block (header .. end marker) from this note.
    // Re-check it is still where we left it before deleting.
    const d = view.state.doc;
    if (endLine <= d.lines && headLine <= d.lines &&
        END_RE.test(d.line(endLine).text) && HEAD_RE.test(d.line(headLine).text)) {
      const from = d.line(headLine).from;
      const to = endLine < d.lines ? d.line(endLine + 1).from : d.line(endLine).to;
      view.dispatch({ changes: { from, to, insert: '' }, userEvent: 'delete' });
    }
    new Notice(`Sent to "${target.basename}"`);
  }
};

module.exports.addEntry = addEntry;
