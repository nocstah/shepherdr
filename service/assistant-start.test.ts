import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execTemplate } from "./spaces.ts";

// #1051: a space's Assistant started from the web ran the stock template's `claude`, whatever Settings › Agents chose.
// A hub whose machine.exec runs here, with HOME a throwaway (its templates folder) and PATH only the CLIs given.
function machine(clis: string[]) {
  const home = mkdtempSync(join(tmpdir(), "shep-assistant-start-")), bin = join(home, "bin"), dir = join(home, ".config", "herdr-core", "templates");
  mkdirSync(bin); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assistant.md"), "---\nname: assistant\ndescription: The Assistant\ncommand: claude\n---\nYou are the Assistant.\n");
  for (const c of clis) { writeFileSync(join(bin, c), "#!/bin/sh\n"); chmodSync(join(bin, c), 0o755); }
  const hub: any = {
    call: async (_: string, a: { argv: string[] }) => {
      // hermetic: where agents install system-wide (core/clean-env.js AGENT_PATH) left out, this VM has them there
      const argv = a.argv.map((x) => x.replace(":/opt/homebrew/bin:/usr/local/bin", ""));
      const p = Bun.spawnSync(argv, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
      const b64 = (x: Uint8Array) => Buffer.from(x).toString("base64");
      return { code: p.exitCode, stdout: b64(p.stdout), stderr: b64(p.stderr) };
    },
  };
  const made = () => readdirSync(dir).filter((f) => f !== "assistant.md").map((f) => readFileSync(join(dir, f), "utf8"));
  return { hub, made, home };
}
const commandOf = (file: string) => /^command:(.*)$/m.exec(file)?.[1] ?? "";

test("the Assistant runs the agent its settings choose, with its model, effort and permissions", async () => {
  const { hub, made } = machine(["codex"]);
  const t = await execTemplate(hub, "assistant", null, { agent: "codex", model: "gpt-5.5", effort: "high", fast: false, perm: "full" });
  const [file] = made();
  expect(commandOf(file)).toContain("exec codex --no-daemon -m gpt-5.5");
  expect(commandOf(file)).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(commandOf(file)).not.toMatch(/exec claude/);
  expect(t.words).toBe("You are the Assistant.");
});

test("no choice: the template's own command, as before", async () => {
  const { hub, made } = machine(["claude"]);
  await execTemplate(hub, "assistant", null, null);
  expect(commandOf(made()[0])).toMatch(/exec claude\s*$/);
});

test("the chosen agent missing there: the template's own; neither there: a plain refusal, never a dead start", async () => {
  const a = machine(["claude"]);
  await execTemplate(a.hub, "assistant", null, { agent: "codex", model: null, effort: null, fast: false, perm: "auto" });
  expect(commandOf(a.made()[0])).toMatch(/exec claude\s*$/);
  const b = machine([]);
  await expect(execTemplate(b.hub, "assistant", null, { agent: "codex", perm: "full" })).rejects.toThrow("Codex isn't installed on this computer");
  expect(b.made()).toEqual([]);
});

// Antigravity as the Assistant: agy runs it with the picked model, level and mode, and as it has no SessionStart hook
// to tell an Assistant its settings and the chat's own words (hooks/session-note.sh), herdr-task's note for its space
// follows the template's words in its first message; once it runs, its terminal is noted as told. Fake CLIs only.
test("an Antigravity Assistant runs agy, its settings note after the template's words", async () => {
  const m = machine(["agy"]);
  const bin = join(m.home, "bin"), calls = join(m.home, "herdr-task-calls");
  writeFileSync(join(bin, "herdr-task"), `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$2" = --space ] && printf 'Herdr chat: the note.\\n\\nYour settings: (for %s)\\n- Review: off\\n' "$3"\nexit 0\n`);
  chmodSync(join(bin, "herdr-task"), 0o755);
  const t = await execTemplate(m.hub, "assistant", null, { agent: "antigravity", model: "gemini-3.8-flash-low", effort: null, fast: false, perm: "auto" }, "sp1");
  const [file] = m.made();
  expect(commandOf(file)).toContain("exec agy --model gemini-3.8-flash --effort low --mode auto");
  expect(commandOf(file)).not.toMatch(/exec claude/);
  // its first message: the template's words, then the note (the person's own words follow it, last: the chat knows them)
  expect(file.endsWith("You are the Assistant.\n\nHerdr chat: the note.\n\nYour settings: (for sp1)\n- Review: off\n")).toBe(true);
  expect(t.words).toBe("You are the Assistant.\n\nHerdr chat: the note.\n\nYour settings: (for sp1)\n- Review: off");
  expect(readFileSync(calls, "utf8")).toBe("_session-note --space sp1\n");
  // once it runs: its terminal noted as told (herdr-task labels it), by its address there
  await t.told("vm/t9");
  expect(readFileSync(calls, "utf8")).toBe("_session-note --space sp1\n_session-note t9\n");
});

test("Antigravity installed only as antigravity: that program; Claude Code and Codex get no note", async () => {
  const a = machine(["antigravity"]);
  await execTemplate(a.hub, "assistant", null, { agent: "antigravity", model: null, effort: null, fast: false, perm: "bypassPermissions" }, "sp1");
  expect(commandOf(a.made()[0])).toMatch(/exec antigravity --dangerously-skip-permissions\s*$/);
  const b = machine(["claude"]);
  const calls = join(b.home, "herdr-task-calls");
  writeFileSync(join(b.home, "bin", "herdr-task"), `#!/bin/sh\necho "$*" >> '${calls}'\n`);
  chmodSync(join(b.home, "bin", "herdr-task"), 0o755);
  const t = await execTemplate(b.hub, "assistant", null, { agent: "claude", model: "opus", effort: null, fast: false, perm: "auto" }, "sp1");
  expect(b.made()[0].endsWith("You are the Assistant.\n")).toBe(true);
  await t.told("t9");
  expect(() => readFileSync(calls, "utf8")).toThrow();
});

test("an older herdr-task there (no --space): the template's words alone, and nothing noted", async () => {
  const m = machine(["agy"]);
  const calls = join(m.home, "herdr-task-calls");
  writeFileSync(join(m.home, "bin", "herdr-task"), `#!/bin/sh\necho "$*" >> '${calls}'\necho "herdr-task: error: unrecognized arguments: --space" >&2\nexit 2\n`);
  chmodSync(join(m.home, "bin", "herdr-task"), 0o755);
  const t = await execTemplate(m.hub, "assistant", null, { agent: "antigravity", model: null, effort: null, fast: false, perm: "auto" }, "sp1");
  expect(m.made()[0].endsWith("You are the Assistant.\n")).toBe(true);
  expect(t.words).toBe("You are the Assistant.");
  await t.told("t9");
  expect(readFileSync(calls, "utf8")).toBe("_session-note --space sp1\n");
});
