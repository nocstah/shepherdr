// A `!` command from the chat box into Antigravity's own shell mode (herdr-chat's providers/antigravity/bang.ts).
// hc send pastes its text (bracketed paste), which agy takes as words for the model, never as its `!` trigger, and hc
// keys can't type a `!`. So the service's own herdr-core link attaches to the terminal and types a raw `!`; only once
// its screen shows shell mode (core/agy-screen.js inShellMode) does the command go in, pasted, then Enter. Nothing else
// is typed when it doesn't open: the `!` is taken back if it landed as a draft.
import * as AG from "../core/agy-screen.js";

type Core = { attach(terminal: string, receive: { data(b: Uint8Array): void; close(): void }, cols?: number, rows?: number): Promise<{ input(b: Uint8Array): void; close(): void }> };
export type BangHub = { call<T = any>(method: string, params?: Record<string, unknown>, timeout?: number): Promise<T>; core(): Promise<Core> };

/** A message that is a `!` command: the command, else null (`!=`, `!!` and a bare `!` are words). */
export function bangOf(text: string): string | null {
  const m = /^!\s*([^\s=!][\s\S]*)$/.exec(String(text ?? "").trim());
  return m ? m[1].replace(/\x1b\[20[01]~/g, "").trim() || null : null;
}

const enc = (s: string) => new TextEncoder().encode(s);

/** A `!` command sent from the chat. agy 1.5 writes none to its transcript, so the chat keeps them itself (the newest
 *  few per agent, while the service runs): its command row (with the page's id), with what it printed, read from its
 *  screen; read: the looking ended, with or without output. A log that has it (SHELL_EXEC, a version that writes
 *  them) shows it instead. */
export type Bang = { id: string; cid?: string; cmd: string; at: number; out?: string; read?: boolean };
const bangs = new Map<string, Bang[]>();
let seq = 0;
export const bangsOf = (addr: string): Bang[] => bangs.get(addr) ?? [];
export function noteBang(addr: string, cmd: string, at: number, cid?: string): Bang {
  const b: Bang = { id: `bang:${++seq}`, cmd, at, ...(cid ? { cid } : {}) };
  bangs.set(addr, [...bangsOf(addr), b].slice(-30));
  return b;
}

/** What it printed, read from its screen for a few seconds after it went in; none by then: it printed nothing (or
 *  runs on), and its row stops saying Running. */
export async function readBang(hub: BangHub, addr: string, b: Bang, changed: () => void, o: { looks?: number; every?: number } = {}) {
  for (let i = 0; i < (o.looks ?? 20); i++) {
    await Bun.sleep(o.every ?? 500);
    const text = String((await hub.call<any>("terminal.read", { terminal: addr, lines: 0 }, 8000).catch(() => null))?.text ?? "");
    const out = AG.bangOutput(text, b.cmd);
    if (out !== null) { b.out = out; b.read = true; changed(); return; }
  }
  b.read = true;
  changed();
}

/** Runs `cmd` in Antigravity's `!` mode in terminal `addr`. -> null when it went in, else why not, in words. */
export async function sendBang(hub: BangHub, addr: string, cmd: string, o: { wait?: number; every?: number; enter?: number } = {}): Promise<string | null> {
  const wait = o.wait ?? 1500, every = o.every ?? 50;
  const screen = async () => String((await hub.call<any>("terminal.read", { terminal: addr, lines: 0 }, 8000))?.text ?? "");
  const got: any = await hub.call("terminal.get", { terminal: addr }, 8000);
  const rec = got?.terminal ?? got;
  if (rec?.state !== "live") return "That agent isn't running.";
  const st = typeof rec.status === "string" ? rec.status : rec.status?.state;
  if (st === "working") return "Antigravity is working: send the command once it's done.";
  if (st === "blocked") return "Antigravity is asking something in its terminal: answer that first.";
  const before = await screen();
  if (AG.inShellMode(before)) return "Antigravity's prompt is in shell mode already: finish or cancel it in its terminal first.";
  if (!AG.atPrompt(before)) return "Antigravity isn't at its prompt: try again once it is.";
  const core = await hub.core();
  const stream = await core.attach(addr, { data() {}, close() {} }, Number(rec.cols) || 80, Number(rec.rows) || 24);
  try {
    stream.input(enc("!"));
    let last = before, open = false;
    for (const end = Date.now() + wait; Date.now() < end;) {
      await Bun.sleep(every);
      last = await screen();
      if (AG.inShellMode(last)) { open = true; break; }
    }
    if (!open) {
      // its `!` landed as a draft: taken back
      if (last !== before) stream.input(enc("\x7f"));
      return "Antigravity didn't open its shell mode (is its prompt empty?): run it in its terminal.";
    }
    stream.input(enc(`\x1b[200~${cmd}\x1b[201~`));
    await Bun.sleep(o.enter ?? 80);
    stream.input(enc("\r"));
    return null;
  } finally {
    stream.close();
  }
}
