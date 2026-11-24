import { expect, test } from "bun:test";
import { AgentWatch } from "./watch.ts";

test("a lost session is reported without starting a replacement", async () => {
  const calls: string[][] = [];
  const terminal = { address: "t1", state: "live", argv: ["claude", "--resume", "old"], labels: { "herdr.role": "coordinator" } };
  const hub: any = { terminals: new Map([["t1", terminal]]), send: () => { throw new Error("must not send to the shell"); } };
  const hc = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: args[0] === "get" ? JSON.stringify(terminal) : "No conversation found" };
  };
  const watch = new AgentWatch(hub, hc, { watched: () => [], changed: () => {} });
  await (watch as any).checkLost({ addr: "t1" });
  expect(calls.map((a) => a[0])).toEqual(["get", "read"]);
  expect(watch.notes.get("t1")?.text).toContain("Restart");
});

test("Antigravity's trust dialog as it starts is one card, its own (service/agy-asks.ts), never a start card too", async () => {
  const TRUST = ["Do you trust the contents of this project?", "", "> Yes, I trust this folder", "  No, exit", "", "  ↑/↓ Navigate · enter Confirm"].join("\n");
  const terminal = { address: "t1", state: "live", status: null, turn: 0, created_ms: Date.now() - 60_000, cols: 100, argv: ["agy"], foreground: { name: "agy", pid: 9 }, labels: { "herdr.agent": "antigravity" } };
  const hub: any = { terminals: new Map([["t1", terminal]]) };
  const hc = async (args: string[]) => ({ code: 0, stdout: args[0] === "read" ? TRUST : "" });
  const watch = new AgentWatch(hub, hc, { watched: () => [{ addr: "t1" }], changed: () => {} });
  // (a start card waits for the same screen twice)
  await (watch as any).tick();
  await (watch as any).tick();
  expect(watch.cardsOf("t1")).toEqual([]);
  expect(watch.agy.open("t1")?.prompt.kind).toBe("confirm");
});
