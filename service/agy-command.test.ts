// Since 3.2.18's command rows (#1482): a `!` command sent to an Antigravity chat still goes into agy's own shell mode
// (service/agy-bang.ts), and the chat shows it as Claude Code's and Codex's: one command row on your side, running until
// its screen shows what it printed (or the looking ends), then done, with the page's id so it takes the sent one's
// place. One its log keeps as well (SHELL_EXEC) shows once. Fake data.
import { expect, test } from "bun:test";
import { Compat } from "./compat.ts";
import { noteBang, readBang, type BangHub } from "./agy-bang.ts";
import * as CL from "../core/chat-log.js";
const { Conversation } = CL as any;

const agy = { state: "live", status: { state: "idle" }, labels: { "herdr.agent": "antigravity" } };
function chatOf(addr: string, conv = new Conversation("antigravity")): any[] {
  const c = new Compat() as any;
  // the chat's terminal, as the service knows it
  c.chats.set("p:local:s1", addr);
  return c.chat("p:local:s1", { conv, start: 0, machine: null, addr, kind: "antigravity" }, agy).messages;
}
const RULE = "─".repeat(80);
const screen = (lines: string[]): BangHub => ({ async call() { return { text: [...lines, RULE, ">", RULE].join("\n") }; }, async core() { throw new Error("not typed"); } });

test("a `!` command kept for Antigravity is one command row: running, then done with what it printed", async () => {
  const b = noteBang("agy-c1", "git status --short", 1_000, "c-1");
  const rows = () => chatOf("agy-c1");
  expect(rows()).toEqual([{ id: b.id, who: "you", text: "!git status --short", at: 1_000, cid: "c-1", command: { state: "running" } }]);
  // never the old person's bubble and "Ran a command" tools row
  expect(rows().some((m) => m.activity)).toBe(false);
  let changed = 0;
  await readBang(screen(["● ! git status --short", "  ⎿   M web/a.ts", "     ?? notes.md", ""]), "agy-c1", b, () => changed++, { every: 1 });
  expect(changed).toBe(1);
  expect(rows()[0].command).toEqual({ state: "done", out: " M web/a.ts\n?? notes.md" });
});

test("one whose screen shows nothing printed stops saying Running once the looking ends", async () => {
  const b = noteBang("agy-c2", "true", 2_000, "c-2");
  let changed = 0;
  await readBang(screen(["● ! true"]), "agy-c2", b, () => changed++, { looks: 3, every: 1 });
  expect(b.out).toBeUndefined();
  expect(changed).toBe(1);
  expect(chatOf("agy-c2")[0]).toMatchObject({ cid: "c-2", command: { state: "done" } });
  expect(chatOf("agy-c2")[0].command.out).toBeUndefined();
});

test("a command its log keeps too (SHELL_EXEC) shows once, as the log's row", () => {
  noteBang("agy-c3", "ls", 3_000_000, "c-3");
  const conv = new Conversation("antigravity");
  conv.command({ cmd: "ls", out: "a.txt", state: "done" }, 7, 3_000_400);
  const rows = chatOf("agy-c3", conv);
  expect(rows.filter((m) => m.command).map((m) => [m.id, m.text, m.command.state, m.command.out])).toEqual([["k7", "!ls", "done", "a.txt"]]);
});
