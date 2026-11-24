"""Agent sessions: the Claude Code, Codex or Antigravity session a task's agent runs, so it can resume."""

import json
import os
import re
import shutil
import time

from .base import HOME, now, run
from .agents import agent_running, detail


# ---- agent sessions -------------------------------------------------------------------------

# GitHub #1013: a `pgrep -P` per process (each reads every process on the machine) for each agent of each
# task, from every tracker and list, kept a busy machine's CPUs full. One read of the process table now
# serves all of a pass's lookups: /proc on Linux (no process started), one `ps` elsewhere (macOS).

TABLE_FOR = 2.0          # seconds a read of the process table serves (a pass's agents, a list's tasks)
_table = {"at": None, "children": {}}


def _read_table():
    """{parent pid: [child pid, …]} of every process now, all as strings."""
    children = {}
    if os.path.isdir("/proc/self"):
        for n in os.listdir("/proc"):
            if not n.isdigit():
                continue
            try:
                with open(f"/proc/{n}/stat", "rb") as f:
                    stat = f.read()
                # "pid (name) state ppid …": the name may hold spaces and brackets, so read after its last ")"
                ppid = stat[stat.rindex(b")") + 2:].split(None, 2)[1].decode()
            except (OSError, ValueError, IndexError):
                continue   # it ended while being read
            children.setdefault(ppid, []).append(n)
        return children
    for line in run(["ps", "-axo", "pid=,ppid="]).stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            children.setdefault(parts[1], []).append(parts[0])
    return children


def _ordered(children):
    """Each parent's children by pid, as pgrep -P gave them (two agents under one shell: the older first)."""
    for v in children.values():
        v.sort(key=int)
    return children


def process_children():
    """The process table's {parent: [children]}, read at most once per TABLE_FOR."""
    t = time.monotonic()
    if _table["at"] is None or t - _table["at"] > TABLE_FOR:
        _table["children"], _table["at"] = _ordered(_read_table()), t
    return _table["children"]


def kids(pid):
    """Every process under pid, from the shared process table, in the order the pgrep walk gave: each child, then
    everything under it, then its next sibling (session_of takes the first that names a session)."""
    children = process_children()
    out, todo, seen = [], [str(pid)], {str(pid)}
    while todo:
        p = todo.pop()
        if p != str(pid):
            out.append(p)
        fresh = [c for c in children.get(p, []) if c not in seen]
        seen.update(fresh)
        todo.extend(reversed(fresh))
    return out


def own_claude_dir(pid):
    """The CLAUDE_CONFIG_DIR process pid was started with (GitHub #1120: a profile per folder, a dev container's
    /app/claude), read from its environment: /proc on Linux, `ps -E` elsewhere (macOS); None when it has none."""
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            words = f.read().decode("utf-8", "replace").split("\0")
    except OSError:
        if os.path.isdir("/proc/self") or not shutil.which("ps"):
            return None
        words = run(["ps", "-wwE", "-o", "command=", "-p", str(pid)]).stdout.split()
    for w in words:
        if w.startswith("CLAUDE_CONFIG_DIR=") and len(w) > 18:
            return w[18:]
    return None


def claude_homes():
    """Claude Code's config folders to look in without a process to ask: herdr-task's own CLAUDE_CONFIG_DIR, then
    ~/.claude (#1120)."""
    return list(dict.fromkeys(x for x in (os.environ.get("CLAUDE_CONFIG_DIR"), os.path.join(HOME, ".claude")) if x))


# Antigravity (agy): its data folder (ANTIGRAVITY_CLI_DATA_DIR, else ANTIGRAVITY_APP_DATA_DIR, else
# ~/.gemini/antigravity-cli). A running agy holds open a presence lock named after the conversation it shows
# (presence/<id>.lock), and its conversation's database (conversations/<id>.db); its log is the transcript it writes
# as it goes (brain/<id>/.system_generated/logs/transcript.jsonl).
UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
AGY_LOCK = re.compile(rf"^(.*)/presence/({UUID})\.lock$")
AGY_DB = re.compile(rf"^(.*)/conversations/({UUID})\.db$")


def agy_home():
    """Antigravity's data folder here."""
    return os.environ.get("ANTIGRAVITY_CLI_DATA_DIR") or os.environ.get("ANTIGRAVITY_APP_DATA_DIR") \
        or os.path.join(HOME, ".gemini", "antigravity-cli")


def agy_log(base, sid):
    """A conversation's transcript in data folder base, or None until agy wrote it."""
    f = os.path.join(base, "brain", sid, ".system_generated", "logs", "transcript.jsonl")
    return f if os.path.isfile(f) else None


def agy_session(files):
    """(conversation id, transcript or None) from the files an agy process holds open: its presence lock, else its
    conversation's database; several (a subagent's beside its own): the one whose transcript was written last.
    (None, None) before its first message (no lock yet)."""
    for pat in (AGY_LOCK, AGY_DB):
        found = {}
        for f in files:
            m = pat.match(f)
            if m:
                found.setdefault(m.group(2).lower(), m.group(1))
        if found:
            def written(item):
                log = agy_log(item[1], item[0])
                return os.path.getmtime(log) if log else 0
            sid, base = max(found.items(), key=written)
            return sid, agy_log(base, sid)
    return None, None


def open_files(p):
    """The paths process p holds open: /proc on Linux, lsof elsewhere (macOS); [] when it can't be told."""
    files = []
    fd = f"/proc/{p}/fd"
    if os.path.isdir(fd):
        for n in os.listdir(fd):
            try:
                files.append(os.readlink(os.path.join(fd, n)))
            except OSError:
                pass
    elif shutil.which("lsof"):
        files = [l[1:] for l in run(["lsof", "-p", p, "-Fn"]).stdout.split("\n") if l.startswith("n")]
    return files


def session_of(pid):
    """(session id, log path) of the agent process pid (or a child), as core/chat-log.js finds it:
    Claude Code names its session in <its config folder>/sessions/<pid>.json (~/.claude, or the
    process's own CLAUDE_CONFIG_DIR: #1120); Codex holds its rollout open (beside its subagents',
    which are skipped); Antigravity its presence lock (agy_session: its log may not be written yet)."""
    for p in [str(pid)] + kids(pid):
        c = os.path.join(HOME, ".claude")
        if not os.path.isfile(os.path.join(c, "sessions", p + ".json")):
            c = own_claude_dir(p) or c
        j = os.path.join(c, "sessions", p + ".json")
        if os.path.isfile(j):
            try:
                with open(j) as f:
                    sid = json.load(f).get("sessionId")
            except (OSError, ValueError):
                sid = None
            if sid:
                log = None
                base = os.path.join(c, "projects")
                for d in os.listdir(base) if os.path.isdir(base) else []:
                    f = os.path.join(base, d, sid + ".jsonl")
                    if os.path.isfile(f):
                        log = f
                        break
                return sid, log
        files = open_files(p)
        sid, log = agy_session(files)
        if sid:
            return sid, log
        for f in files:
            m = re.search(r"/rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", f)
            if m and not subagent_rollout(f):
                return m.group(1), f
    return None, None


def subagent_rollout(path):
    """Whether a Codex rollout is one of its subagents' (the approval reviewer, "guardian", or a spawned
    helper), which its process holds open beside its own (GitHub #1201): its session_meta's source is
    {"subagent": …}. Never the session to show or resume."""
    try:
        with open(path, errors="replace") as f:
            o = json.loads(f.readline())
    except (OSError, ValueError):
        return False
    src = ((o.get("payload") or {}) if isinstance(o, dict) and o.get("type") == "session_meta" else {}).get("source")
    return isinstance(src, dict) and "subagent" in src


def refresh_sessions(s, task, live):
    """Records each live agent's current session (it changes on /clear)."""
    for k in live:
        k = detail(k)
        pid = (k.get("foreground") or {}).get("pid")
        a = next((a for a in task["agents"] if a["address"] == k["address"]), None)
        if not pid or not a or not agent_running(k):
            continue
        sid, log = session_of(pid)
        if sid and (a.get("session"), a.get("log")) != (sid, log):
            a["session"], a["log"] = sid, log
            s.dirty = True


# ---- a lost agent's log (SHEP-26) -----------------------------------------------------------
# An agent that ended before a pass saw its session (a short run, or one that exited on its own)
# has no log on its task, so its chat would look as if it never started. Its log is still on this
# machine: found once by its session id, else as the Claude Code session or Codex rollout that
# started in its folder from its launch on and whose first message names its task.

LOOK_BACK_MS = 60000       # a log that starts this long before its agent's launch (clocks, a slow start) still counts


def _ms(stamp):
    """An ISO timestamp ("2026-11-05T08:30:43.116Z") in ms, or None."""
    import datetime
    try:
        return int(datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _words(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(x.get("text") or "") for x in content if isinstance(x, dict))
    return ""


def _start(path):
    """(when, first message) a log starts with: Claude Code's first user entry, Codex's session_meta
    and first user message, Antigravity's first USER_INPUT. (None, "") if it has none in its first lines."""
    at, said = None, ""
    try:
        with open(path, errors="replace") as f:
            for i, line in enumerate(f):
                if i > 80:
                    break
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                p = o.get("payload") or {}
                if o.get("type") == "session_meta":
                    at = at or _ms(p.get("timestamp") or o.get("timestamp"))
                elif o.get("type") == "user" and not o.get("isMeta"):
                    at = at or _ms(o.get("timestamp"))
                    said = _words((o.get("message") or {}).get("content"))
                elif o.get("type") == "USER_INPUT":
                    at, said = at or _ms(o.get("created_at")), str(o.get("content") or "")
                elif o.get("type") == "response_item" and p.get("role") == "user":
                    w = _words(p.get("content"))
                    if not w.lstrip().startswith("<"):  # not Codex's own <environment_context> or instructions
                        at, said = at or _ms(o.get("timestamp")), w
                if said:
                    break
    except OSError:
        pass
    return at, said


def project_dir(folder, home=None):
    """Claude Code's projects folder for a cwd: every character but a letter or digit becomes "-"."""
    return os.path.join(home or os.path.join(HOME, ".claude"), "projects", re.sub(r"[^A-Za-z0-9]", "-", folder))


def log_by_session(kind, sid):
    import glob
    if kind == "antigravity":
        return agy_log(agy_home(), sid)
    if kind == "codex":
        found = glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", f"rollout-*{sid}.jsonl"))
    else:
        found = [f for h in claude_homes() for f in glob.glob(os.path.join(h, "projects", "*", sid + ".jsonl"))]
    return found[0] if found else None


def find_log(a, ref, folders, taken=()):
    """The log of agent `a` (a task's agents[] row) of task `ref` (SHEP-26), run in one of `folders`,
    or None: by its session when it has one, else the earliest log of its kind that started from
    its launch on (until it ended) and whose first message names its task."""
    import glob
    kind = a.get("agent") if a.get("agent") in ("codex", "antigravity") else "claude"
    if a.get("session"):
        return log_by_session(kind, a["session"])
    at = a.get("at")
    if not at:
        return None
    end = a.get("ended") or at + 86400000
    if kind == "antigravity":
        files = glob.glob(os.path.join(agy_home(), "brain", "*", ".system_generated", "logs", "transcript.jsonl"))
    elif kind == "codex":
        import datetime
        days = {datetime.date.fromtimestamp((at + d) / 1000) for d in (-86400000, 0, 86400000)}
        files = [f for day in days for f in glob.glob(os.path.join(HOME, ".codex", "sessions", f"{day:%Y}", f"{day:%m}", f"{day:%d}", "rollout-*.jsonl"))]
    else:
        files = [f for h in claude_homes() for d in dict.fromkeys(x for x in folders if x) for f in glob.glob(os.path.join(project_dir(d, h), "*.jsonl"))]
    named = re.compile(rf"(?<![\w-]){re.escape(ref)}(?![\w-])")
    best = None
    for f in files:
        if f in taken:
            continue
        try:
            if os.path.getmtime(f) * 1000 < at - LOOK_BACK_MS:
                continue  # last written before it started
        except OSError:
            continue
        start, said = _start(f)
        if start is None or not (at - LOOK_BACK_MS <= start <= end) or not named.search(said):
            continue
        if not best or start < best[0]:
            best = (start, f)
    return best[1] if best else None


def find_lost_logs(s, task):
    """Records the log of each of the task's ended agents that has none (looked for once each)."""
    folders = [task.get("worktree"), s.loc.get("folder")]
    taken = {a.get("log") for a in task.get("agents") or [] if a.get("log")}
    for a in task.get("agents") or []:
        if a.get("log") or a.get("log_looked"):
            continue
        log = find_log(a, s.ref(task), folders + [a.get("cwd")], taken)
        a["log_looked"] = now()
        if log:
            a["log"] = log
            taken.add(log)
        s.dirty = True
