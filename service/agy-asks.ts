// Antigravity's own asks as chat cards: it has no hook, so while herdr-core says it is blocked (its permission asks,
// ask_question, trust this folder), its screen is read (core/agy-screen.js) and the dialog on it becomes a card. A
// tap presses that answer in its terminal, as a person would, only while its screen still shows the same dialog
// (keyOf). Each dialog is a card of its own: a question of several shows one at a time, as agy asks them. A card ends
// when its dialog goes: answered from the chat (how it was), or in the terminal.
import * as AG from "../core/agy-screen.js";
import { starting } from "../core/screens.js";
import type { Question } from "../web/shared/types.ts";

type Run = (args: string[]) => Promise<{ code: number; stdout: string; stderr?: string }>;

/** A dialog's card: open while its dialog shows. */
export type AgyCard = { id: string; addr: string; key: string; prompt: any; at: number; state: "open" | "closed"; how?: string };

/** how many closed cards an agent keeps (their quiet lines) */
const KEEP = 6;
/** a card that was pressed gets this long for its dialog to go before it counts as still asking */
const PRESSED = 4000;

const label = (r: any) => String(r?.label ?? "").replace(/^\(recommended\)\s*/i, "");
const recommended = (r: any) => /^\(recommended\)/i.test(String(r?.label ?? ""));

/** The agent a card's id names ("agy:<address>:<n>"). */
export const cardAddr = (id: string) => String(id).slice(4, String(id).lastIndexOf(":"));

/** What a closed card says, as a hook ask's line: "Run: npm test · Allowed in the chat". */
export function endWords(c: AgyCard) {
  const p = c.prompt, cmd = p.kind === "permission" ? AG.commandOf(p) : null;
  const what = p.kind === "question" ? p.question : cmd ? `Run: ${cmd.split("\n")[0].slice(0, 120)}` : p.title;
  return `${what} · ${c.how ?? "Answered in the terminal"}`;
}

/** A dialog as the chat's card (web/plugins/chat/cards.tsx): a permission as its command with Allow once and Decline
 *  (Allow once is its first yes, Decline its no), a question as its choices (several picked when it takes several, a
 *  written answer in its write-in), a confirm (trust this folder) as its choices pressed at once. */
export function agyQuestion(c: AgyCard, to: string, by?: { ref: string; title: string; chat: string }): Question {
  const p = c.prompt, id = c.id;
  if (p.kind === "question") {
    return { id, title: p.question, kind: "Question", to, choices: p.rows.map((r: any) => ({ label: label(r), ...(r.description ? { description: r.description } : {}), ...(recommended(r) ? { recommended: true } : {}) })),
      ...(p.multi ? { multi: true } : {}), ...(p.other ? { other: true } : {}), noNote: true, asks: "Antigravity asks", ...(by ? { by } : {}) } as Question;
  }
  const allow = p.rows.find((r: any) => AG.choiceKind(p.rows, r) === "allow"), deny = p.rows.find((r: any) => AG.choiceKind(p.rows, r) === "deny");
  if (p.kind === "permission" && allow && deny) {
    const cmd = AG.commandOf(p);
    return { id, title: cmd ? "Run a command" : p.title, kind: "Question", to, command: cmd ?? [p.body, p.title].filter(Boolean).join("\n\n"),
      choices: [{ label: "Allow once" }, { label: "Decline" }], noNote: true, ...(by ? { by } : {}) } as Question;
  }
  return { id, title: p.title, kind: "Question", to, ...(p.body ? { screen: p.body } : {}), press: true, noNote: true,
    choices: p.rows.map((r: any) => ({ label: r.label, ...(r.description ? { description: r.description } : {}) })), ...(by ? { by } : {}) } as Question;
}

export class AgyAsks {
  private cards = new Map<string, AgyCard[]>();
  private seq = 0;
  private looking = new Set<string>();
  private pressed = new Map<string, number>();

  constructor(private hc: Run, private changed: () => void) {}

  /** An agent's cards, oldest first. */
  of(addr: string): AgyCard[] { return this.cards.get(addr) ?? []; }
  open(addr: string): AgyCard | null { const c = this.of(addr).at(-1); return c?.state === "open" ? c : null; }

  private close(c: AgyCard, how: string) {
    c.state = "closed";
    c.how ??= how;
    this.cards.set(c.addr, this.of(c.addr).slice(-KEEP));
    this.changed();
  }

  /** A message from the chat goes past its open dialog (Esc, then the words): how its card ended, as a hook ask's. */
  aside(addr: string) {
    const c = this.open(addr);
    if (!c || c.how) return;
    c.how = c.prompt.kind === "question" ? "Left to talk over in the chat" : "Dismissed in the chat";
    this.pressed.set(c.id, Date.now());
  }

  /** Looks at an Antigravity terminal (k: its record): a dialog on its screen while it is blocked is a card, and one
   *  while it starts, before herdr-core has a word on it (trust this folder: core/screens.js starting). */
  async tick(addr: string, k: any) {
    const open = this.open(addr);
    const st = typeof k?.status === "string" ? k.status : k?.status?.state ?? null;
    if (k?.state !== "live" || (st !== "blocked" && !starting(k))) {
      if (open) this.close(open, k?.state === "live" ? "Answered in the terminal" : "The agent stopped");
      return;
    }
    if (this.looking.has(addr)) return;
    this.looking.add(addr);
    try {
      const r = await this.hc(["read", addr, "--lines", "0"]);
      if (r.code !== 0) return;
      const p = AG.read(r.stdout);
      const key = p ? AG.keyOf(p) : "";
      if (open && open.key === key) { open.prompt = p; return; }
      // its dialog went: answered (the press's words are on it already), or in its terminal
      if (open) {
        if (!p && Date.now() - (this.pressed.get(open.id) ?? 0) < PRESSED) return;
        this.close(open, "Answered in the terminal");
      }
      if (!p) return;
      const card: AgyCard = { id: `agy:${addr}:${++this.seq}`, addr, key, prompt: p, at: Date.now(), state: "open" };
      this.cards.set(addr, [...this.of(addr), card]);
      this.changed();
    } finally {
      this.looking.delete(addr);
    }
  }

  /** A tap on a card: its answer pressed on its screen. b: the page's answer ({ choice } | { choices } | { other } |
   *  { dismiss } | { terminal }). -> what went wrong, or null. */
  async answer(id: string, b: any): Promise<string | null> {
    const c = [...this.cards.values()].flat().find((x) => x.id === id);
    if (!c || c.state !== "open") return "This question is no longer waiting.";
    if (b?.terminal === true) return null;
    const screen = await this.hc(["read", c.addr, "--lines", "0"]);
    if (screen.code !== 0) return "Its terminal can't be read: answer it there.";
    const p = AG.read(screen.stdout);
    if (!p || AG.keyOf(p) !== c.key) return "Its screen shows something else now: answer it in the terminal.";
    const keys = async (...k: string[]) => { if (k.length && (await this.hc(["keys", c.addr, ...k])).code !== 0) throw new Error("It didn't go through: answer it in the terminal."); };
    const done = (how: string) => { this.pressed.set(c.id, Date.now()); c.how = how; this.changed(); return null; };
    try {
      if (b?.dismiss === true || b?.talk === true) { await keys("esc"); return done("Dismissed in the chat"); }
      if (p.kind === "question") return await this.answerQuestion(c, p, b, keys, done);
      // a permission's card: Allow once is its first yes, Decline its no; a confirm's: the choice tapped
      let row: any = null;
      if (c.prompt.kind === "permission" && agyQuestion(c, "").command !== undefined) row = p.rows.find((r: any) => AG.choiceKind(p.rows, r) === (b?.choice === 0 ? "allow" : "deny"));
      else if (typeof b?.choice === "number") row = p.stops[b.choice];
      if (!row) return "Pick an answer first.";
      await keys(...AG.movesTo(p, row), "enter");
      return done(c.prompt.kind === "permission" ? (AG.choiceKind(p.rows, row) === "deny" ? "Declined in the chat" : "Allowed in the chat") : `Answered in the chat: ${row.label}`);
    } catch (e: any) {
      return e?.message ?? "It didn't go through.";
    }
  }

  private async answerQuestion(c: AgyCard, p: any, b: any, keys: (...k: string[]) => Promise<void>, done: (how: string) => null) {
    const typed = typeof b?.other === "string" ? b.other.replace(/\s*\n\s*/g, " ").trim() : "";
    if (typed) {
      if (!p.other) return "This question takes one of its options only.";
      // its write-in: there, Enter opens it, then the words and Enter
      await keys(...AG.movesTo(p, p.other), "enter");
      await Bun.sleep(250);
      const r = await this.hc(["send", "--force", c.addr, typed]);
      if (r.code !== 0) return "It didn't go through: answer it in the terminal.";
      return done(`Answered in the chat: ${typed}`);
    }
    if (!p.multi) {
      const row = typeof b?.choice === "number" ? p.rows[b.choice] : null;
      if (!row) return "Pick an answer first.";
      await keys(...AG.movesTo(p, row), "enter");
      return done(`Answered in the chat: ${label(row)}`);
    }
    // several: each picked one ticked (and each unpicked one cleared), from the cursor down, then Submit
    const picks = new Set<number>(Array.isArray(b?.choices) ? b.choices.filter((n: unknown) => typeof n === "number") : []);
    if (!picks.size) return "Pick an answer first.";
    const out: string[] = [];
    let at = p.stops.find((r: any) => r.selected)?.stop ?? 0;
    p.rows.forEach((r: any, i: number) => {
      if (Boolean(r.checked) === picks.has(i)) return;
      for (; at !== r.stop; at += r.stop > at ? 1 : -1) out.push(r.stop > at ? "down" : "up");
      out.push("space");
    });
    const end = p.submit ?? p.rows[0];
    for (; at !== end.stop; at += end.stop > at ? 1 : -1) out.push(end.stop > at ? "down" : "up");
    await keys(...out, "enter");
    return done(`Answered in the chat: ${p.rows.filter((_: any, i: number) => picks.has(i)).map(label).join(", ")}`);
  }
}
