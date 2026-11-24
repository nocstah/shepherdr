import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIND, LOG, Conversation, records, resultText, agyArgs, agyUserText, agyQuestions } from "./chat-log.js";
import { KINDS, kindOf } from "./chat-reader.js";

// An Antigravity CLI 1.5.16 transcript (<data>/brain/<id>/.system_generated/logs/transcript.jsonl): one step a line,
// its keys in its order, each call argument a JSON-encoded string. Synthetic words in the real files' shape.
const dirs = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agy-log-")); dirs.push(d); return d; };

let n = 0;
const at = (s) => `2026-11-24T15:${String(30 + Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}+07:00`;
const step = (type, more, status = "DONE", source = "MODEL") => ({ step_index: n++, source, type, status, created_at: at(n), ...more });
const user = (words, more = {}) => step("USER_INPUT", { content: `<USER_REQUEST>\n${words}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${at(n)}.\n</ADDITIONAL_METADATA>`, ...more }, "DONE", "USER_EXPLICIT");
const call = (name, args) => ({ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)])) });
const reply = (content, calls = [], more = {}) => step("PLANNER_RESPONSE", { model: "gemini-3.8-flash-low", input_tokens: 9000, cache_read_tokens: 2000, output_tokens: 120, thinking: "", content, ...(calls.length ? { tool_calls: calls } : {}), ...more });
const times = `Created At: ${at(1)}\nCompleted At: ${at(2)}\n`;
const result = (words, status = "DONE", more = {}) => step("GENERIC", { content: times + words, ...more }, status);

async function sh(script, args, env = {}) {
  const p = Bun.spawn(["sh", "-c", script, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
  return (await new Response(p.stdout).text()).trim();
}
function transcript(lines, data = scratch(), id = "0a1b2c3d-1111-2222-3333-444455556666") {
  const dir = join(data, "brain", id, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "transcript.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { data, id, f };
}
async function read(lines) {
  const { f } = transcript(lines);
  const c = new Conversation("antigravity");
  c.feed(records(await sh(LOG, ["log", "tail", f, "0"])).records);
  return { c, f };
}
const kinds = (c) => c.items.map((x) => x.kind);
const steps = (c) => c.items.filter((x) => x.kind === "tools").flatMap((x) => x.steps);

test("its CLI is a chat kind: agy, by its status or its process", () => {
  expect(KINDS.antigravity).toBe("antigravity");
  expect(kindOf({ status: { app: "antigravity" } })).toBe("antigravity");
  expect(kindOf({ foreground: { name: "agy" } })).toBe("antigravity");
});

test("its arguments, its message's own words, its questions", () => {
  expect(agyArgs({ Path: '"/a/b.ts"', StartLine: "10", Flag: "true", List: '["x"]', Plain: "words" })).toEqual({ Path: "/a/b.ts", StartLine: 10, Flag: true, List: ["x"], Plain: "words" });
  // cut at about 2 KB: the value as far as it went
  expect(agyArgs({ CommandLine: '"echo \\"hi\\" and on\n<truncated 812 bytes>' }).CommandLine).toBe('echo "hi" and on');
  expect(agyUserText("<USER_REQUEST>\nHello there\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>")).toBe("Hello there");
  expect(agyQuestions('[{"is_multi_select":true,"options":["(Recommended) apple","pear"],"question":"Fruit?"}]'))
    .toEqual([{ text: "Fruit?", header: "", multi: true, choices: [{ label: "(Recommended) apple" }, { label: "pear" }] }]);
});

test("a turn: the person's message, its reply, a command row with its output, its model and use", async () => {
  n = 0;
  const { c, f } = await read([
    step("SYSTEM_MESSAGE", { content: "<SYSTEM_MESSAGE>reminder</SYSTEM_MESSAGE>" }, "DONE", "SYSTEM"),
    user("Is the site up?"),
    reply("", [call("run_command", { CommandLine: "curl -sI https://example.com | head -n 1", WaitMsBeforeAsync: 5000, toolSummary: "Check the site" })]),
    result("Command exited with code 0.\n\nCommand output:\nHTTP/2 200"),
    reply("It is up: **HTTP/2 200**."),
    step("CHECKPOINT", { content: "a summary" }),
  ]);
  expect(kinds(c)).toEqual(["user", "tools", "agent"]);
  expect(c.items[0].text).toBe("Is the site up?");
  expect(c.items[2].text).toBe("It is up: **HTTP/2 200**.");
  const [s] = steps(c);
  expect(s.kind).toBe("run");
  expect(s.line).toBe("Ran curl -sI https://example.com | head -n 1");
  expect(s.out).toBeGreaterThan(0);
  const r = await sh(LOG, ["log", "results", f, String(s.out)]);
  const part = r.split("\x1e")[1];
  expect(resultText(part.slice(part.indexOf("\n") + 1), s.id)).toBe("Command exited with code 0.\n\nCommand output:\nHTTP/2 200");
  expect(c.meta).toMatchObject({ model: "gemini-3.8-flash-low", effort: "low", used: 11120 });
  // a reply with no call ends its turn
  expect(c.doing).toBeNull();
  expect(c.open.size).toBe(0);
});

test("its question: asked, answered by a pick (none of the person's words), by several, written in, or skipped", async () => {
  n = 0;
  const ask = (q, options, multi = false) => call("ask_question", { questions: JSON.stringify([{ is_multi_select: multi, options, question: q }]) });
  const { c } = await read([
    user("Ask me things."),
    reply("", [ask("Which colour?", ["(Recommended) red", "blue"])]),
    result("A1: blue"),
    reply("", [ask("Which fruits?", ["(Recommended) apple", "pear", "plum"], true)]),
    result("A1: (Recommended) apple, plum"),
    reply("", [ask("Which city?", ["Oslo", "Bergen"])]),
    result("A1: Tromsø"),
    reply("", [ask("Which day?", ["Monday", "Friday"])]),
    result("A1: User Skipped"),
    reply("Noted."),
  ]);
  const asks = c.items.filter((x) => x.kind === "ask");
  expect(asks.map((x) => [x.text, x.closed])).toEqual([["Which colour?", "answered"], ["Which fruits?", "answered"], ["Which city?", "answered"], ["Which day?", "dismissed"]]);
  expect(asks[1].questions[0].multi).toBe(true);
  // only the written-in answer is the person's message
  expect(c.items.filter((x) => x.kind === "user" && x.answer).map((x) => x.text)).toEqual(["Tromsø"]);
});

test("an open question is what it does now", async () => {
  n = 0;
  const { c } = await read([user("Ask."), reply("", [call("ask_question", { questions: JSON.stringify([{ is_multi_select: false, options: ["a", "b"], question: "Which?" }]) })])]);
  expect(c.doing).toBe("Asking you something");
  expect(c.items.at(-1)).toMatchObject({ kind: "ask", text: "Which?" });
  expect(c.items.at(-1).closed).toBeUndefined();
});

test("a command it left running in the background, ended by its notice", async () => {
  n = 0;
  const conv = "0a1b2c3d-1111-2222-3333-444455556666";
  const lines = [
    user("Run the server."),
    reply("", [call("run_command", { CommandLine: "npm run dev", WaitMsBeforeAsync: 500 })]),
    result(`Tool is running as a background task with task id: ${conv}/task-7`, "RUNNING"),
    reply("It runs in the background."),
  ];
  const { c } = await read(lines);
  expect(c.bg.map((b) => b.task)).toEqual([`${conv}/task-7`]);
  const { c: after } = await read([...lines, step("SYSTEM_MESSAGE", { content: `Task id "${conv}/task-7" finished with result: ok` }, "DONE", "SYSTEM")]);
  expect(after.bg).toEqual([]);
});

test("a picture a step made shows as its; an error as an error; a picture sent shows on the message", async () => {
  n = 0;
  const { c } = await read([
    user("Look at this.", { media: [{ mime_type: "image/png", uri: "/home/someone/shot.png" }] }),
    reply("", [call("browser_screenshot", { toolSummary: "Screenshot the page" })]),
    result("Took a screenshot.", "DONE", { media: [{ mime_type: "image/png", uri: "file:///data/brain/x/media/step_2_media_0.png" }] }),
    step("ERROR_MESSAGE", { error: "The model is overloaded." }, "DONE", "SYSTEM"),
  ]);
  expect(c.items[0]).toMatchObject({ kind: "user", text: "Look at this.", images: 1, paths: ["/home/someone/shot.png"] });
  expect(c.items.find((x) => x.made)?.text).toBe("![step_2_media_0.png](/data/brain/x/media/step_2_media_0.png)");
  expect(c.items.at(-1)).toMatchObject({ kind: "error", text: "The model is overloaded." });
});

test("a step too big to read whole still shows its calls", async () => {
  n = 0;
  const { c } = await read([user("Write it."), reply("x".repeat(270000), [call("write_file", { TargetFile: "/a/big.txt", Content: "y" })]), result("Wrote it.")]);
  expect(steps(c).map((s) => s.line)).toEqual(["Wrote a file"]);
  expect(c.open.size).toBe(0);
});

test("FIND: its log by its session when its process holds none, never a session that isn't an id", async () => {
  const home = scratch();
  const { f, id } = transcript([user("hi")], join(home, ".gemini", "antigravity-cli"));
  expect(await sh(FIND, ["chat", "antigravity", "999999", id], { HOME: home })).toBe(f);
  expect(await sh(FIND, ["chat", "antigravity", "999999", "../../etc"], { HOME: home })).toBe("");
});

test("FIND: its log by the presence lock its process holds (no session known)", async () => {
  const data = scratch();
  const { f, id } = transcript([user("hi")], data);
  mkdirSync(join(data, "presence"), { recursive: true });
  const lock = join(data, "presence", `${id}.lock`);
  writeFileSync(lock, "");
  const p = Bun.spawn(["sh", "-c", 'exec 3<"$1"; exec sleep 30', "sh", lock], { stdout: "ignore", stderr: "ignore" });
  try {
    let got = "";
    for (let i = 0; i < 20 && got !== f; i++) { await Bun.sleep(50); got = await sh(FIND, ["chat", "antigravity", String(p.pid)]); }
    expect(got).toBe(f);
  } finally { p.kill(); }
});
