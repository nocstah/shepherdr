import { expect, test } from "bun:test";
import { bangOf, sendBang, noteBang, bangsOf, readBang, type BangHub } from "./agy-bang.ts";

// A fake hub: terminal.get gives its record, terminal.read the screen now; what is typed over its attach is kept, and
// a `!` typed at its prompt opens its shell mode when `opens` says so.
const RULE = "─".repeat(80);
const PROMPT = [RULE, ">", RULE, "? for shortcuts"].join("\n");
const SHELL = [RULE, "! ", RULE, "esc to cancel"].join("\n");
const DRAFT = [RULE, "> !", RULE, "? for shortcuts"].join("\n");
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function hub(o: { status?: string; screen?: string; opens?: boolean; after?: string } = {}): BangHub & { typed: string[]; closed: boolean } {
  const typed: string[] = [];
  let screen = o.screen ?? PROMPT, closed = false;
  const h = {
    typed, get closed() { return closed; },
    async call(method: string): Promise<any> {
      if (method === "terminal.get") return { terminal: { state: "live", status: { state: o.status ?? "idle" }, cols: 80, rows: 24 } };
      if (method === "terminal.read") return { text: screen };
      return null;
    },
    async core() {
      return { attach: async () => ({
        input(b: Uint8Array) {
          const s = dec(b);
          typed.push(s);
          if (s === "!") screen = o.opens === false ? DRAFT : SHELL;
          if (s === "\r" && o.after) screen = o.after;
        },
        close() { closed = true; },
      }) };
    },
  };
  return h;
}

test("a message that is a `!` command; `!=`, `!!` and a bare `!` are words", () => {
  expect(bangOf("!ls -la")).toBe("ls -la");
  expect(bangOf("  ! git status  ")).toBe("git status");
  expect(bangOf("!= is not equal")).toBeNull();
  expect(bangOf("!!")).toBeNull();
  expect(bangOf("!")).toBeNull();
  expect(bangOf("run !ls")).toBeNull();
});

test("a raw `!` opens its shell mode, then the command goes in pasted, then Enter", async () => {
  const h = hub();
  expect(await sendBang(h, "t1", "echo hi", { every: 5, enter: 1 })).toBeNull();
  expect(h.typed).toEqual(["!", "\x1b[200~echo hi\x1b[201~", "\r"]);
  expect(h.closed).toBe(true);
});

test("never while it works or asks, nor when its prompt isn't there", async () => {
  for (const [o, why] of [[{ status: "working" }, /working/], [{ status: "blocked" }, /asking/], [{ screen: SHELL }, /shell mode already/], [{ screen: "Question 1/1: Which?\n> 1. a\n  2. b\n  ↑/↓ Navigate · enter Select" }, /isn't at its prompt/]] as const) {
    const h = hub(o);
    expect(await sendBang(h, "t1", "ls", { every: 5 })).toMatch(why);
    expect(h.typed).toEqual([]);
  }
});

test("shell mode doesn't open: its `!` taken back, nothing else typed", async () => {
  const h = hub({ opens: false });
  expect(await sendBang(h, "t1", "ls", { wait: 40, every: 5 })).toMatch(/didn't open its shell mode/);
  expect(h.typed).toEqual(["!", "\x7f"]);
});

test("the chat keeps what it sent, with what its screen shows it printed", async () => {
  const done = [RULE, "● ! echo hi", "  ⎿  hi", "", RULE, ">", RULE].join("\n");
  const b = noteBang("t9", "echo hi", 1000, "c-1");
  expect(bangsOf("t9")).toEqual([b]);
  let changed = 0;
  await readBang(hub({ screen: done }), "t9", b, () => changed++, { every: 1 });
  expect(b.out).toBe("hi");
  expect(changed).toBe(1);
});
