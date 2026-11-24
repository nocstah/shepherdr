"""service/restart.sh for another machine's agent: it runs there, over hc (SHEP-107)."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest

def read(p):
    with open(p) as f:
        return f.read()


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "service", "restart.sh")

# A fake hc: logs each call (and what came on stdin); `exec` answers as the other machine would, `machine ls` says
# whether that machine is reachable.
FAKE_HC = r"""#!/usr/bin/env bash
log=$FAKE_DIR/calls
printf '%s\n' "$*" >>"$log"
case $1 in
  exec)
    cat >"$FAKE_DIR/stdin"
    printf '%s\n' "$@" >"$FAKE_DIR/exec-args"
    [ "$FAKE_STATE" = connected ] || exit 1
    echo t9 ;;
  machine) printf '{"machines":[{"name":"vmb","state":"%s"}]}\n' "$FAKE_STATE" ;;
  *) echo "the local core was used: $*" >&2; exit 9 ;;
esac
"""


class RemoteRestart(unittest.TestCase):
    def run_script(self, state, env=None):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(FAKE_HC)
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "FAKE_DIR": d, "FAKE_STATE": state, **(env or {})}
        r = subprocess.run(["bash", SCRIPT, "vmb/t2", json.dumps(["claude", "--model", "sonnet"])], env=e,
                           capture_output=True, text=True, timeout=30)
        return r, d

    def test_runs_on_its_machine(self):
        r, d = self.run_script("connected", {"HERDR_RESTART_CHAT": "pane1", "HERDR_RESTART_RESUME": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "vmb/t9")
        args = read(os.path.join(d, "exec-args")).split("\n")
        self.assertEqual(args[:3], ["exec", "--on", "vmb"])
        self.assertIn("HERDR_RESTART_CHAT=pane1", args)
        self.assertIn("HERDR_RESTART_RESUME=1", args)
        # the script itself goes over, with that machine's own address for the agent
        tail = args[args.index("--") + 1:]
        self.assertEqual(tail[:3], ["bash", "-s", "t2"])
        self.assertEqual(json.loads(tail[3]), ["claude", "--model", "sonnet"])
        self.assertEqual(read(os.path.join(d, "stdin")), read(SCRIPT))
        # nothing ran on this machine's core
        self.assertTrue(all(c.startswith("exec ") for c in read(os.path.join(d, "calls")).splitlines()))

    def test_no_env_without_a_chat(self):
        r, d = self.run_script("connected")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("--env", read(os.path.join(d, "exec-args")).split("\n"))

    def test_offline_says_so(self):
        r, _ = self.run_script("disconnected")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stderr.strip(), "vmb is offline. Try again once it's back.")
        self.assertEqual(r.stdout, "")


# A fake hc for an agent on this machine: `get` answers its record, `run` logs its arguments.
LOCAL_HC = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DIR/calls"
case $1 in
  get) echo '{"address":"t2","cwd":"/tmp","labels":{"herdr.chat":"vmb/p7","herdr.role":"coordinator"}}' ;;
  run) printf '%s\n' "$@" >"$FAKE_DIR/run-args"; echo '{"address":"t9"}' ;;
  ls) echo '{"terminals":[]}' ;;
esac
"""


class ChatLabel(unittest.TestCase):
    """The new agent's herdr.chat holds its pane as its own machine names it, never a window's "<machine>/<pane>"
    (GitHub #761: another machine's window then misses the pane and ends the agent)."""

    def restart(self, env):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(LOCAL_HC)
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "HERDR_APP_HOME": d, "FAKE_DIR": d, "HERDR_RESTART_RESUME": "1", **env}
        r = subprocess.run(["bash", SCRIPT, "t2", json.dumps(["claude", "--resume", "s1"])], env=e,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        return read(os.path.join(d, "run-args")).split("\n")

    def test_window_name_from_the_chat(self):
        self.assertIn("herdr.chat=p7", self.restart({"HERDR_RESTART_CHAT": "vmb/p7"}))

    def test_window_name_from_its_label(self):
        args = self.restart({})
        self.assertIn("herdr.chat=p7", args)
        self.assertNotIn("herdr.chat=vmb/p7", args)


class NoTab(unittest.TestCase):
    """GitHub #980: an Assistant the service started without the window (a web-only install, service/spaces.ts) has
    a space but no tab or chat. restart.sh quit at its first guard without a word, and the remote side dropped its
    stderr: all anyone saw was "It didn't restart". It restarts in the background under its space now, and a
    restart that can't says why, across machines too."""

    def restart(self, labels, env=None, argv=("claude", "--resume", "s1")):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        rec = json.dumps({"address": "t2", "cwd": "/tmp", "template": "assistant", "labels": labels})
        with open(hc, "w") as f:
            f.write(LOCAL_HC.replace(LOCAL_HC.split("\n")[3], f"  get) echo '{rec}' ;;"))
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "HERDR_APP_HOME": d, "FAKE_DIR": d, "HERDR_RESTART_RESUME": "1", **(env or {})}
        r = subprocess.run(["bash", SCRIPT, "t2", json.dumps(list(argv))], env=e, capture_output=True, text=True, timeout=30)
        p = os.path.join(d, "run-args")
        return r, (read(p).split("\n") if os.path.exists(p) else None)

    def test_a_space_alone_restarts_in_the_background(self):
        r, args = self.restart({"herdr.space": "sp1", "herdr.coordinator.space": "sp1", "herdr.role": "coordinator"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        self.assertIn("--keep", args)
        for label in ("herdr.space=sp1", "herdr.coordinator.space=sp1", "herdr.role=coordinator"):
            self.assertIn(label, args)
        self.assertFalse(any(a.startswith("herdr.tab=") for a in args), "no empty tab label")

    def test_nowhere_to_go_says_why(self):
        r, args = self.restart({"herdr.role": "coordinator"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("t2 has no space, tab or chat to restart into.", r.stderr)
        self.assertIsNone(args)

    def test_the_other_machine_says_why(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(FAKE_HC.replace("    echo t9 ;;", '    [ -n "$FAKE_WHY" ] && { echo "$FAKE_WHY" >&2; exit 1; }\n    echo t9 ;;'))
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "FAKE_DIR": d, "FAKE_STATE": "connected",
             "FAKE_WHY": "t2 has no space, tab or chat to restart into."}
        r = subprocess.run(["bash", SCRIPT, "vmb/t2", "[]"], env=e, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stderr.strip(), "It didn't restart on vmb: t2 has no space, tab or chat to restart into.")


class AntigravityAssistant(unittest.TestCase):
    """Antigravity as the Assistant. agy has no SessionStart hook to tell an Assistant its settings and the chat's own
    words: switched to it, they follow the template's words in its first message (herdr-task's note for its space),
    before the handoff, and its terminal is noted as told once it runs; resumed on its own conversation, what that
    conversation was told stays told on the new terminal. Its herdr.agent label is its key, antigravity, not agy."""

    LABELS = {"herdr.space": "sp1", "herdr.coordinator.space": "sp1", "herdr.role": "coordinator",
              "herdr.settings": "review:1a2b3c", "herdr.reactions": "on"}

    def restart(self, argv, env):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        tdir = os.path.join(d, ".config", "herdr-core", "templates")
        os.makedirs(tdir)
        with open(os.path.join(tdir, "assistant.md"), "w") as f:
            f.write("---\nname: assistant\ndescription: x\ncommand: claude\n---\nYou are the Assistant.\n")
        rec = json.dumps({"address": "t2", "cwd": "/tmp", "template": "assistant", "labels": self.LABELS})
        # run: its arguments, and the one-off template it was given (removed once it has started)
        hc = LOCAL_HC.replace(LOCAL_HC.split("\n")[3], f"  get) echo '{rec}' ;;").replace(
            "  run) printf '%s\\n' \"$@\" >\"$FAKE_DIR/run-args\";",
            "  run) printf '%s\\n' \"$@\" >\"$FAKE_DIR/run-args\"; for a; do t=$a; done; cp \"" + tdir + "/$t.md\" \"$FAKE_DIR/tpl\" 2>/dev/null;")
        with open(os.path.join(d, "bin", "hc"), "w") as f:
            f.write(hc)
        with open(os.path.join(d, "bin", "herdr-task"), "w") as f:
            f.write('#!/bin/sh\necho "$*" >> "$FAKE_DIR/herdr-task"\n[ "$2" = --space ] && printf \'Your settings: (for %s)\\n- Review: off\' "$3"\nexit 0\n')
        for x in ("hc", "herdr-task"):
            os.chmod(os.path.join(d, "bin", x), 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "HERDR_APP_HOME": d, "FAKE_DIR": d, **env}
        r = subprocess.run(["bash", SCRIPT, "t2", json.dumps(argv)], env=e, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        got = lambda n: read(os.path.join(d, n)) if os.path.exists(os.path.join(d, n)) else ""
        return got("run-args").split("\n"), got("tpl"), got("herdr-task")

    def test_switched_to_antigravity_its_note_goes_in_its_first_message(self):
        args, tpl, asked = self.restart(["agy", "--model", "gemini-3.8-flash", "--effort", "low"], {})
        self.assertIn("herdr.agent=antigravity", args)
        self.assertNotIn("herdr.settings=review:1a2b3c", args, "a new conversation: told afresh, not carried")
        self.assertIn("exec agy --model gemini-3.8-flash --effort low", tpl)
        body = tpl.split("---\n", 2)[2]
        self.assertTrue(body.startswith("You are the Assistant.\n\nYour settings: (for sp1)\n- Review: off\n\nYou are taking over this tab"), body[:200])
        self.assertEqual(asked.split("\n"), ["_session-note --space sp1", "_session-note t9", ""])

    def test_resumed_on_its_conversation_it_stays_told(self):
        args, _, asked = self.restart(["agy", "--model", "gemini-3.8-flash", "--conversation", "c-1"], {"HERDR_RESTART_RESUME": "1"})
        for label in ("herdr.settings=review:1a2b3c", "herdr.reactions=on", "herdr.agent=antigravity"):
            self.assertIn(label, args)
        self.assertEqual(args[args.index("herdr-clean") + 1:][:5], ["agy", "--model", "gemini-3.8-flash", "--conversation", "c-1"])
        self.assertEqual(asked, "")

    def test_claude_code_gets_no_note_its_hook_tells_it(self):
        _, tpl, asked = self.restart(["claude", "--model", "opus"], {})
        self.assertNotIn("Your settings", tpl)
        self.assertEqual(asked, "")


class Bash32(unittest.TestCase):
    """macOS's /bin/bash is 3.2, without bash 4's mapfile and readarray (GitHub #736): restart.sh still restarts."""

    def restart(self, env):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(LOCAL_HC)
        os.chmod(hc, 0o755)
        # BASH_ENV runs before the script: it takes bash 4's builtins away, as on bash 3.2.
        old = os.path.join(d, "bash32")
        with open(old, "w") as f:
            f.write("enable -n mapfile readarray\n")
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "HERDR_APP_HOME": d, "FAKE_DIR": d, "BASH_ENV": old, **env}
        r = subprocess.run(["bash", SCRIPT, "t2", json.dumps(["claude", "--model", "a b"])], env=e,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        return r, read(os.path.join(d, "run-args")).split("\n")

    def test_resume(self):
        r, args = self.restart({"HERDR_RESTART_RESUME": "1"})
        self.assertNotIn("command not found", r.stderr)
        self.assertEqual(args[args.index("herdr-clean") + 1:][:3], ["claude", "--model", "a b"])

    def test_handoff(self):
        r, args = self.restart({})
        self.assertNotIn("command not found", r.stderr)
        self.assertIn("herdr.agent=claude", args)


if __name__ == "__main__":
    unittest.main()
