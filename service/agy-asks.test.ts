import { expect, test } from "bun:test";
import { AgyAsks, agyQuestion, cardAddr, endWords } from "./agy-asks.ts";

// Antigravity's dialogs (synthetic words in agy 1.5.16's layout) and a fake hc: `read` gives the screen now, `keys`
// and `send` are kept.
const RULE = "─".repeat(100);
const PERMISSION = ["● Ran (npm test) (ctrl+o to expand)", "", "Command", RULE, "Requesting permission for:", "   npm test", "", "Run this command?",
  "> 1. Yes, run command", "  2. Yes, and always allow in this conversation for commands that start with 'npm test'", "  3. No, cancel", "",
  "  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command", "esc to cancel"].join("\n");
const QUESTION = ["Question", RULE, "Question 1/1: Which colour do you like?", "", "> 1. (Recommended) red", "  2. blue", "  3. Write-in...", "",
  "  ↑/↓ Navigate · enter Select · esc Skip", "esc to cancel"].join("\n");
const MULTI = ["Question", RULE, "Question 1/1: Which fruits do you like?", "", "> 1. [ ] apple", "  2. [x] pear", "  3. [ ] plum", "  4. Write-in...", "",
  "  ↑/↓ Navigate · space Toggle · enter Submit · esc Skip", "esc to cancel"].join("\n");
const TRUST = ["Do you trust the contents of this project?", "", "> Yes, I trust this folder", "  No, exit", "", "  ↑/↓ Navigate · enter Confirm"].join("\n");
const IDLE = [RULE, ">", RULE, "? for shortcuts"].join("\n");

function fake(screen: string) {
  const calls: string[][] = [];
  const s = { screen, calls, changes: 0 };
  const hc = async (a: string[]) => {
    calls.push(a);
    if (a[0] === "read") return { code: 0, stdout: s.screen };
    return { code: 0, stdout: "" };
  };
  const asks = new AgyAsks(hc, () => { s.changes++; });
  return { s, asks, pressed: () => calls.filter((c) => c[0] === "keys" || c[0] === "send") };
}
const blocked = { state: "live", status: { state: "blocked", app: "antigravity" } };

test("a permission ask while it is blocked: a card with its command, Allow once and Decline", async () => {
  const { asks, s } = fake(PERMISSION);
  await asks.tick("t1", blocked);
  const c = asks.open("t1")!;
  expect(c).not.toBeNull();
  expect(cardAddr(c.id)).toBe("t1");
  expect(s.changes).toBe(1);
  const q = agyQuestion(c, "p:sp1");
  expect(q).toMatchObject({ title: "Run a command", command: "npm test", choices: [{ label: "Allow once" }, { label: "Decline" }] });
  // read again with the same dialog: the same card
  await asks.tick("t1", blocked);
  expect(asks.of("t1").length).toBe(1);
});

test("Allow once presses its first yes; Decline its no, from where its cursor is", async () => {
  const a = fake(PERMISSION);
  await a.asks.tick("t1", blocked);
  expect(await a.asks.answer(a.asks.open("t1")!.id, { choice: 0 })).toBeNull();
  expect(a.pressed()).toEqual([["keys", "t1", "enter"]]);
  const d = fake(PERMISSION);
  await d.asks.tick("t1", blocked);
  expect(await d.asks.answer(d.asks.open("t1")!.id, { choice: 1 })).toBeNull();
  expect(d.pressed()).toEqual([["keys", "t1", "down", "down", "enter"]]);
  // once its dialog goes, the card ends with how it was answered
  d.s.screen = IDLE;
  await d.asks.tick("t1", { state: "live", status: { state: "working" } });
  const c = d.asks.of("t1")[0];
  expect(c.state).toBe("closed");
  expect(endWords(c)).toBe("Run: npm test · Declined in the chat");
});

test("a dialog that changed since the card was drawn is never pressed", async () => {
  const { asks, s, pressed } = fake(PERMISSION);
  await asks.tick("t1", blocked);
  s.screen = PERMISSION.replaceAll("npm test", "rm -rf build");
  expect(await asks.answer(asks.open("t1")!.id, { choice: 0 })).toMatch(/something else now/);
  expect(pressed()).toEqual([]);
});

test("its question: a pick, a written answer in its write-in, or Esc to dismiss", async () => {
  const pick = fake(QUESTION);
  await pick.asks.tick("t1", blocked);
  const card = pick.asks.open("t1")!;
  expect(agyQuestion(card, "p:sp1")).toMatchObject({ title: "Which colour do you like?", asks: "Antigravity asks", other: true,
    choices: [{ label: "red", recommended: true }, { label: "blue" }] });
  expect(await pick.asks.answer(card.id, { choice: 1 })).toBeNull();
  expect(pick.pressed()).toEqual([["keys", "t1", "down", "enter"]]);

  const own = fake(QUESTION);
  await own.asks.tick("t1", blocked);
  expect(await own.asks.answer(own.asks.open("t1")!.id, { other: "green" })).toBeNull();
  expect(own.pressed()).toEqual([["keys", "t1", "down", "down", "enter"], ["send", "--force", "t1", "green"]]);

  const no = fake(QUESTION);
  await no.asks.tick("t1", blocked);
  expect(await no.asks.answer(no.asks.open("t1")!.id, { dismiss: true })).toBeNull();
  expect(no.pressed()).toEqual([["keys", "t1", "esc"]]);
});

test("a question of several: each pick ticked and each unpicked one cleared, then Enter", async () => {
  const { asks, pressed } = fake(MULTI);
  await asks.tick("t1", blocked);
  const card = asks.open("t1")!;
  expect(agyQuestion(card, "p:sp1").multi).toBe(true);
  // apple and plum wanted; pear (ticked) not
  expect(await asks.answer(card.id, { choices: [0, 2] })).toBeNull();
  expect(pressed()).toEqual([["keys", "t1", "space", "down", "space", "down", "space", "up", "up", "enter"]]);
});

test("trust this folder: its choices, pressed at once", async () => {
  const { asks, pressed } = fake(TRUST);
  await asks.tick("t1", blocked);
  const card = asks.open("t1")!;
  expect(agyQuestion(card, "p:sp1")).toMatchObject({ press: true, choices: [{ label: "Yes, I trust this folder" }, { label: "No, exit" }] });
  expect(await asks.answer(card.id, { choice: 0 })).toBeNull();
  expect(pressed()).toEqual([["keys", "t1", "enter"]]);
});

test("a message from the chat goes past its question: its card says it was left to talk over", async () => {
  const { asks, s } = fake(QUESTION);
  await asks.tick("t1", blocked);
  asks.aside("t1");
  s.screen = IDLE;
  await asks.tick("t1", { state: "live", status: { state: "idle" } });
  expect(endWords(asks.of("t1")[0])).toBe("Which colour do you like? · Left to talk over in the chat");
});

test("answered in its terminal, or its agent gone: the card ends so", async () => {
  const { asks } = fake(PERMISSION);
  await asks.tick("t1", blocked);
  await asks.tick("t1", { state: "live", status: { state: "working" } });
  expect(endWords(asks.of("t1")[0])).toBe("Run: npm test · Answered in the terminal");
  const gone = fake(PERMISSION);
  await gone.asks.tick("t1", blocked);
  await gone.asks.tick("t1", { state: "exited" });
  expect(gone.asks.of("t1")[0].how).toBe("The agent stopped");
  expect(await gone.asks.answer(gone.asks.of("t1")[0].id, { choice: 0 })).toMatch(/no longer waiting/);
});
