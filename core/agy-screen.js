// Antigravity CLI's (agy) own dialogs, read from its screen: it has no hook for its permission asks or its
// ask_question tool, so the chat reads them as a person would (herdr-chat's providers/antigravity/screen.ts, agy 1.5):
// numbered permission and question dialogs (1. Yes / 2. No, "Question 1/3", [ ] boxes, Submit, a write-in row) and
// unnumbered confirm dialogs (> Yes, I trust this folder / No, exit), plus whether its prompt is in `!` shell mode.
// A card is drawn from what read() gives and pressed only while the screen still shows the same dialog (keyOf()).
// Shared core: the source is core/agy-screen.js. Plain JavaScript, no imports.

const SOLID = /^\s*─{8,}\s*$/;
const COMPOSER = /^>\s*(?:$|Auto mode:|Plan mode:|Accept-edits mode:|Type a message|Ask anything|[^\d])/i;
const STATUS_LEFT = /^(?:\?\s+for shortcuts|esc to cancel|Press up to edit queued messages)\b/i;
const STATUS_RIGHT = /^(?:(auto|plan|accept-edits)\s*·\s*)?(.+?)(?:\s*·\s*(low|medium|high|xhigh|max))?$/i;
// a slash command's own picker (/model, /config, /resume...): not an ask
const OVERLAY = /(?:Keyboard:.*\besc\b|enter\s+Select\s+esc\b|\besc\s+Go\s+Back\b|\besc\s+to\s+(?:go\s+back|close)\b)/i;
// a dialog's footer while agy waits for an answer
const FOOTER = /(?:↑\/↓\s*Navigate\s*·\s*enter\s*Confirm|enter\s*(?:to\s*)?(?:confirm|select|submit)|esc\s*(?:to\s*)?(?:cancel|deny|reject|skip)|tab\s*(?:to\s*)?(?:add\s*(?:notes|feedback|instructions)|reject)|space\s*(?:to\s*)?toggle|press\s+1|f\s+to\s+view\s+full\s+diff)/i;
const NUMBERED = /^(\s*)([>›❯▸]\s*)?(\d+)\.\s+(.*)$/;
const CURSOR = /^(\s*)([>›❯▸])\s+(.+)$/;
const BOX = /^\[([ ✔✓xX])\]\s+(.*)$/;
const SUBMIT = /^\s*([>›❯▸]\s*)?Submit\s*$/i;
const OTHER = /^(?:Other(?:\b|\s*\(|:|$)|Type (?:your answer|something)|Write-in(?:\b|\.{3}|…))/i;
const HEADER = /^(?:Question\s+\d+\/\d+.*|.*(?:\?|:))$/i;
const YES = /^(?:Yes|Allow|Approve|Run|Accept)\b/i;
const NO = /^(?:No|Deny|Reject|Cancel)\b/i;

const blank = (l) => !l.trim();
const indent = (l) => /^\s*/.exec(l)[0].length;

function screenLines(screen) {
  const lines = String(screen ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && blank(lines[lines.length - 1])) lines.pop();
  return lines;
}

// "Option A   Its description" split on two spaces or more
function columns(text) {
  const m = /^(.+?)\s{2,}(\S.*)$/.exec(text);
  return m ? { label: m[1].trim(), description: m[2].trim() } : { label: text.trim() };
}

/** Its status line ("? for shortcuts      auto · Gemini 3.8 Flash · low"): { mode, model, effort }, else null. */
export function statusBar(screen) {
  const lines = screenLines(screen);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const raw = lines[i];
    if (SOLID.test(raw) || OVERLAY.test(raw)) continue;
    const parts = raw.trim().split(/\s{2,}/);
    const right = parts[parts.length - 1]?.trim() ?? "";
    if (!right || (!right.includes("·") && !STATUS_LEFT.test(parts[0] ?? ""))) continue;
    if (STATUS_LEFT.test(right) || /Navigate|Confirm|shortcuts/i.test(right)) continue;
    const m = STATUS_RIGHT.exec(right);
    if (!m || !m[2]?.trim()) continue;
    return { mode: m[1]?.toLowerCase() ?? "default", model: m[2].trim(), effort: m[3]?.toLowerCase() ?? null };
  }
  return null;
}

function withoutStatus(lines) {
  return lines.length && statusBar(lines[lines.length - 1]) ? lines.slice(0, -1) : lines;
}

// Rows numbered 1..N in order above a footer: { rows, first, footer }, else null.
function numbered(lines) {
  let footer = lines.length;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) if (FOOTER.test(lines[i])) { footer = i; break; }
  let end = -1;
  for (let i = footer - 1; i >= Math.max(0, footer - 50); i--) if (NUMBERED.test(lines[i])) { end = i; break; }
  if (end < 0) return null;
  const at = [];
  let want = Number(NUMBERED.exec(lines[end])[3]);
  if (want < 2) return null;
  for (let i = end; i >= Math.max(0, end - 60) && want >= 1; i--) {
    const m = NUMBERED.exec(lines[i]);
    if (!m) continue;
    if (Number(m[3]) !== want) return null;
    at.unshift(i);
    want--;
  }
  if (want !== 0) return null;
  // a cursor on a row, or a dialog's footer: an ordinary numbered list in a reply is never a dialog
  if (!at.some((i) => NUMBERED.exec(lines[i])[2]) && footer === lines.length) return null;
  const rows = [];
  for (let k = 0; k < at.length; k++) {
    const i = at[k], m = NUMBERED.exec(lines[i]);
    const col = m[1].length + (m[2]?.length ?? 0) + m[3].length + 2;
    let text = m[4].trim();
    const notes = [];
    let submit = null;
    for (let j = i + 1; j < (at[k + 1] ?? footer); j++) {
      const l = lines[j];
      if (SUBMIT.test(l)) { submit = { n: null, label: "Submit", selected: Boolean(SUBMIT.exec(l)[1]) }; break; }
      if (blank(l) || SOLID.test(l) || FOOTER.test(l) || indent(l) < col - 2) break;
      notes.push(l.trim());
    }
    const box = BOX.exec(text);
    if (box) text = box[2].trim(); else text = text.replace(/^✓\s+/, "").trim();
    const split = columns(text);
    const description = [split.description, ...notes].filter(Boolean).join(" ");
    rows.push({ n: Number(m[3]), label: split.label, ...(description ? { description } : {}), selected: Boolean(m[2]), ...(box ? { checked: box[1] !== " " } : {}), stop: rows.length });
    if (submit) rows.push({ ...submit, stop: rows.length });
  }
  return { rows, first: at[0], footer };
}

// An unnumbered choice dialog (> Yes, I trust this folder / No, exit) over its footer.
function confirm(lines) {
  let footer = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) if (FOOTER.test(lines[i])) { footer = i; break; }
  if (footer < 0) return null;
  let cur = -1;
  for (let i = footer - 1; i >= Math.max(0, footer - 15); i--) if (CURSOR.test(lines[i])) { cur = i; break; }
  if (cur < 0) return null;
  const col = CURSOR.exec(lines[cur])[1].length + 2;
  let first = cur, last = cur;
  while (first > 0) {
    const prev = lines[first - 1];
    if (blank(prev) || SOLID.test(prev)) break;
    if (CURSOR.test(prev) || (indent(prev) === col && prev.trim().length <= 80 && !/[?:]$/.test(prev.trim()))) first--;
    else break;
  }
  while (last + 1 < footer) {
    const next = lines[last + 1];
    if (blank(next) || SOLID.test(next)) break;
    if (CURSOR.test(next) || (indent(next) === col && next.trim().length <= 80)) last++;
    else break;
  }
  const rows = [];
  for (let i = first; i <= last; i++) {
    const m = CURSOR.exec(lines[i]);
    rows.push({ n: null, label: (m ? m[3] : lines[i]).trim(), selected: Boolean(m), stop: rows.length });
  }
  if (rows.length < 2) return null;
  let top = first - 1;
  while (top >= 0 && !SOLID.test(lines[top])) top--;
  const above = lines.slice(top + 1, first).map((l) => l.trim()).filter(Boolean);
  const q = above.findIndex((l) => /\?$/.test(l));
  const title = q >= 0 ? above[q] : above[0] ?? "Antigravity needs confirmation";
  return { kind: "confirm", title, body: above.filter((_, i) => i !== (q >= 0 ? q : 0)).join("\n"), rows, stops: rows };
}

/** The dialog Antigravity waits on now, else null:
 *    { kind: "permission" | "confirm", title, body, rows, stops }
 *    { kind: "question", progress ("Question 1/3"), question, rows, other (its write-in row), submit, multi, stops }
 *  rows: { n, label, description?, selected (the cursor), checked?, stop (its place among stops) }. */
export function read(screen) {
  const lines = withoutStatus(screenLines(screen));
  if (!lines.length || lines.slice(-6).some((l) => OVERLAY.test(l))) return null;
  const num = numbered(lines);
  if (!num) return confirm(lines);
  let top = num.first - 1;
  const min = Math.max(-1, num.first - 40);
  while (top > min && !SOLID.test(lines[top])) top--;
  const above = lines.slice(top + 1, num.first);
  while (above.length && blank(above[0])) above.shift();
  while (above.length && blank(above[above.length - 1])) above.pop();
  const submit = num.rows.find((r) => r.n === null && r.label === "Submit") ?? null;
  const rows = num.rows.filter((r) => r !== submit);
  const multi = rows.some((r) => r.checked !== undefined);
  const other = rows.find((r) => OTHER.test(r.label)) ?? null;
  const approval = rows.some((r) => YES.test(r.label)) && rows.some((r) => NO.test(r.label));
  if (!approval && (multi || other || above.some((l) => /^Question\s+\d+\/\d+/i.test(l.trim())))) {
    const p = above.findIndex((l) => /^Question\s+\d+\/\d+/i.test(l.trim()));
    let progress = null, question;
    if (p >= 0) {
      const m = /^(Question\s+\d+\/\d+)(?:\s*:\s*(.*))?$/i.exec(above[p].trim());
      progress = m[1];
      const after = above.slice(p + 1).map((l) => l.trim()).filter(Boolean);
      if (m[2]?.trim()) question = [m[2].trim(), ...after].join(" ");
      else question = after.join(" ") || above.slice(0, p).map((l) => l.trim()).filter((l) => l && !/^Question$/i.test(l)).pop() || "Antigravity has a question";
    } else question = above.map((l) => l.trim()).filter((l) => l && !/^Question$/i.test(l)).pop() ?? "Antigravity has a question";
    return { kind: "question", progress, question, rows: rows.filter((r) => r !== other), other, submit, multi, stops: num.rows };
  }
  let q = -1;
  for (let i = above.length - 1; i >= 0; i--) if (HEADER.test(above[i].trim())) { q = i; break; }
  const title = q >= 0 ? above[q].trim() : above[above.length - 1]?.trim() || "Antigravity needs approval";
  return { kind: "permission", title, body: (q >= 0 ? above.slice(0, q) : above.slice(0, -1)).join("\n").trim(), rows, stops: num.rows };
}

/** What a dialog is, the same however its cursor moves: a press needs the screen to still say this. */
export function keyOf(p) {
  if (!p) return "";
  const head = p.kind === "question" ? `${p.progress ?? ""}\n${p.question}` : `${p.title}\n${p.body}`;
  return `${p.kind}\n${head}\n${p.stops.map((r) => r.label).join("\n")}`.replace(/[ \t]+/g, " ");
}

/** The arrow keys from the cursor's row to `to` (one of p.stops). */
export function movesTo(p, to) {
  const at = p.stops.find((r) => r.selected)?.stop ?? 0;
  const n = to.stop - at;
  return Array.from({ length: Math.abs(n) }, () => (n > 0 ? "down" : "up"));
}

/** A choice's kind on an approval: "allow" (the first yes), "always" (one for good or the session), "deny", or "other". */
export function choiceKind(rows, row) {
  if (NO.test(row.label)) return "deny";
  const firstYes = rows.find((r) => YES.test(r.label));
  if (row === firstYes) return "allow";
  return /\b(?:always|don't ask|session|future)\b/i.test(row.label) ? "always" : "other";
}

/** A command a permission dialog asks to run ("Requesting permission for: <command>"), whole, else null. */
export function commandOf(p) {
  if (p?.kind !== "permission") return null;
  const m = /(?:^|\s)Requesting permission for:\s*([\s\S]+)$/i.exec(p.body);
  if (m) return m[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ") || null;
  if (/\bcommand\b/i.test(p.title) && p.body && !/^\s*[+-]\s/m.test(p.body)) {
    const paras = p.body.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const last = paras[paras.length - 1] ?? "";
    return last.replace(/^(?:Command:\s*|\$\s+)/i, "").split("\n").map((l) => l.trim()).join(" ") || null;
  }
  return null;
}

/** Whether its prompt is in `!` shell mode: a `!` mark in its box, or "activated bash mode" under it, no dialog open. */
export function inShellMode(screen) {
  if (read(screen)) return false;
  const lines = screenLines(screen);
  if (lines.length < 3) return false;
  const tail = lines.slice(-12);
  let bottom = -1;
  for (let i = tail.length - 1; i >= 0; i--) if (SOLID.test(tail[i])) { bottom = i; break; }
  if (bottom < 1) return false;
  const below = tail.slice(bottom + 1).filter((l) => !blank(l));
  if (below.some((l) => OVERLAY.test(l))) return false;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) if (SOLID.test(tail[i])) { top = i; break; }
  const box = tail.slice(top >= 0 ? top + 1 : Math.max(0, bottom - 4), bottom);
  const first = box.find((l) => !blank(l));
  if (first && /^!(?:\s|$)/.test(first)) return true;
  if (first && /^>/.test(first)) return false;
  return below.some((l) => /\bactivated\s+bash\s+mode\b/i.test(l));
}

/** Whether it sits at its own prompt, nothing open over it (no dialog, no picker). */
export function atPrompt(screen) {
  if (read(screen)) return false;
  const lines = screenLines(screen);
  if (lines.length < 3) return false;
  const tail = lines.slice(-12);
  let bottom = -1;
  for (let i = tail.length - 1; i >= 0; i--) if (SOLID.test(tail[i])) { bottom = i; break; }
  if (bottom < 1) return false;
  const below = tail.slice(bottom + 1).filter((l) => !blank(l));
  if (below.length > 1 || below.some((l) => OVERLAY.test(l))) return false;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) if (SOLID.test(tail[i])) { top = i; break; }
  return tail.slice(top >= 0 ? top + 1 : Math.max(0, bottom - 4), bottom).some((l) => COMPOSER.test(l));
}
