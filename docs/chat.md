# The chat

What you can type in a chat's box besides a message, and the keys that help.

## Commands with `!`

A line that starts with `!` runs as a shell command in the agent's own folder, the way Claude Code's, Codex's and
Antigravity's own boxes do. The box shows it: **Run as a command** above it, the line in monospace. Sending it puts a
command row in the chat, on your side: the command, then how it went (Sending…, Running…, Done, Failed) and what it
printed under it (its last 8000 characters when long). A quoted reply or files in the box stay there for your next message: a command goes
alone, or it would arrive as a message.

What each agent does with it (checked with Claude Code 2.1.331, Codex 0.163.0 and Antigravity 1.5.16):

| | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| Runs it | yes, in its bash mode | yes, as its `!` shell command | yes, in its `!` shell mode, which the service opens by typing a raw `!` (a paste never opens it: `service/agy-bang.ts`) |
| While it works | waits in its queue, runs when the turn ends | not checked yet | not sent: its row says Not sent (Antigravity is working) with Retry |
| The agent sees it | yes: the command and its output are in its context | yes: the command, exit code and output | not checked yet |
| Done or Failed from | where it printed (success to stdout, failure to stderr; nothing at all on a silent failure) | its exit code | Done once its screen shows what it printed, or after 10 s with nothing; never Failed, as its screen shows no exit code |

Antigravity 1.5 writes no `!` run to its log, so the service keeps the ones sent from the chat (the newest 30 per agent,
while it runs) and reads what each printed from its screen. A version that logs them (`SHELL_EXEC`) shows the log's row
instead, with Failed when its line says so.

Before this, the line went in the same way and ran, but the chat showed nothing: the logs keep `!` runs as their own
lines (`<bash-input>`/`<bash-stdout>` in Claude Code's, `<user_shell_command>` in Codex's), which the chat skipped.

An agent with no such shell (none that Shepherdr starts today) can't run it: the box says so, Send stays off, and
**Open your terminal** opens your own shell under the chat instead.

For more than a line or two, your own terminal is the better place: the space's name menu › Terminal, or Ctrl+`.

## Keys

| Keys | What they do |
| --- | --- |
| Enter | Send |
| Shift+Enter | A new line |
| Ctrl+Enter (⌘+Enter) | Send, held until the agent's turn ends |
| Ctrl+K (⌘+K) | Search spaces, tasks and artifacts |
| Ctrl+` | Open or close your own terminal under the chat |
| Esc | Close a menu or the message's quick actions |
