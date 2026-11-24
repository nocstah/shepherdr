import { expect, test } from "bun:test";
import * as AG from "./agy-screen.js";

// Antigravity CLI 1.5.16's screens as hc read gives them: synthetic words in its real layout (its rules 110 wide).
const RULE = "─".repeat(110);
const HEAD = [
  "      ▄▀▀▄        Antigravity CLI 1.5.16",
  "     ▀▀▀▀▀▀       someone@example.com (Google AI Pro)",
  "    ▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (Low)",
  "   ▄▀▀    ▀▀▄     /home/someone/project",
  "  ▄▀▀      ▀▀▄",
  "",
];
const IDLE = [...HEAD, RULE, ">", RULE, `? for shortcuts${" ".repeat(70)}auto · Gemini 3.8 Flash · low`].join("\n");
const PERMISSION = [...HEAD,
  "> Check the site is up.",
  "",
  "● Ran (curl -sI https://example.com | head -n 1) (ctrl+o to expand)",
  "",
  "Command",
  RULE,
  "Requesting permission for:",
  "   curl -sI https://example.com | head -n 1",
  "",
  "Run this command?",
  "> 1. Yes, run command",
  "  2. Yes, and always allow in this conversation for commands that start with 'curl -sI https://example.com'",
  "  3. Yes, and always allow for commands that start with 'curl -sI https://example.com' (Persist to settings.json)",
  "  4. No, cancel",
  "",
  "  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command",
  `esc to cancel${" ".repeat(70)}Gemini 3.8 Flash · low`].join("\n");
const QUESTION = [...HEAD,
  "? Which colour do you like?",
  "",
  "Question",
  RULE,
  "Question 1/1: Which colour do you like?",
  "",
  "> 1. (Recommended) red",
  "  2. blue",
  "  3. Write-in...",
  "",
  "  ↑/↓ Navigate · enter Select · esc Skip",
  `esc to cancel${" ".repeat(70)}Gemini 3.8 Flash · low`].join("\n");
const MULTI = [...HEAD,
  "Question",
  RULE,
  "Question 1/1: Which fruits do you like?",
  "",
  "> 1. [ ] (Recommended) apple",
  "  2. [x] pear",
  "  3. [ ] plum",
  "  4. Write-in...",
  "",
  "  ↑/↓ Navigate · space Toggle · enter Submit · esc Skip",
  "esc to cancel"].join("\n");
const TRUST = [...HEAD,
  "Do you trust the contents of this project?",
  "",
  "> Yes, I trust this folder",
  "  No, exit",
  "",
  "  ↑/↓ Navigate · enter Confirm"].join("\n");
const SHELL = [...HEAD,
  "● ! echo one && echo two",
  "  ⎿  one",
  "     two",
  "",
  RULE, "! ", RULE, "esc to cancel"].join("\n");

test("its prompt with nothing open over it, and what its status line says", () => {
  expect(AG.read(IDLE)).toBeNull();
  expect(AG.atPrompt(IDLE)).toBe(true);
  expect(AG.inShellMode(IDLE)).toBe(false);
  expect(AG.statusBar(IDLE)).toEqual({ mode: "auto", model: "Gemini 3.8 Flash", effort: "low" });
});

test("a permission ask: its command, its allow and deny rows, the keys to each", () => {
  const p = AG.read(PERMISSION);
  expect(p.kind).toBe("permission");
  expect(p.title).toBe("Run this command?");
  expect(AG.commandOf(p)).toBe("curl -sI https://example.com | head -n 1");
  expect(p.rows.map((r) => r.n)).toEqual([1, 2, 3, 4]);
  expect(p.rows.map((r) => AG.choiceKind(p.rows, r))).toEqual(["allow", "always", "always", "deny"]);
  expect(AG.movesTo(p, p.rows[0])).toEqual([]);
  expect(AG.movesTo(p, p.rows[3])).toEqual(["down", "down", "down"]);
  expect(AG.atPrompt(PERMISSION)).toBe(false);
  // the same dialog drawn again is the same key; another command's is not
  expect(AG.keyOf(AG.read(PERMISSION + "\n"))).toBe(AG.keyOf(p));
  expect(AG.keyOf(AG.read(PERMISSION.replaceAll("example.com", "example.org")))).not.toBe(AG.keyOf(p));
});

test("ask_question's dialog: its question, its choices, its write-in", () => {
  const q = AG.read(QUESTION);
  expect(q.kind).toBe("question");
  expect(q.progress).toBe("Question 1/1");
  expect(q.question).toBe("Which colour do you like?");
  expect(q.rows.map((r) => r.label)).toEqual(["(Recommended) red", "blue"]);
  expect(q.other?.label).toBe("Write-in...");
  expect(q.multi).toBeFalsy();
  expect(AG.movesTo(q, q.other)).toEqual(["down", "down"]);
});

test("a question that takes several: each row's tick", () => {
  const q = AG.read(MULTI);
  expect(q.kind).toBe("question");
  expect(q.multi).toBe(true);
  expect(q.rows.map((r) => [r.label, !!r.checked])).toEqual([["(Recommended) apple", false], ["pear", true], ["plum", false]]);
});

test("trust this folder: a confirm of two rows", () => {
  const c = AG.read(TRUST);
  expect(c.kind).toBe("confirm");
  expect(c.rows.map((r) => r.label)).toEqual(["Yes, I trust this folder", "No, exit"]);
  expect(c.rows[0].selected).toBe(true);
});

test("its ! shell mode, and what a ! command printed", () => {
  expect(AG.inShellMode(SHELL)).toBe(true);
  expect(AG.read(SHELL)).toBeNull();
  expect(AG.bangOutput(SHELL, "echo one && echo two")).toBe("one\ntwo");
  expect(AG.bangOutput(SHELL, "ls")).toBeNull();
  // still running: no output under it yet
  expect(AG.bangOutput([RULE, "● ! sleep 5", "", RULE, ">", RULE].join("\n"), "sleep 5")).toBeNull();
});
