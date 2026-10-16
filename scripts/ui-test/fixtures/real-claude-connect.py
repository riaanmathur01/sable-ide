"""Start the REAL, unmodified `claude` CLI in a pseudo-terminal, pointed at a
temp config folder, with Sable's IDE-integration environment, wait for it
to start, and quit it. It never types a prompt (no request reaches the
model and nothing uses your subscription), and the temp config holds no
credentials: the CLI there is simply "not logged in". HOME is a temp
folder too, so the real ~/.claude is neither read nor changed.

  python3 real-claude-connect.py <claude> <config_dir> <workspace> <port> <seconds>

Prints the screen text it saw (escape sequences stripped). Used by
claude-code-cli.mjs when SABLE_TEST_REAL_CLAUDE=1.
"""
import json
import os
import pty
import re
import select
import signal
import sys
import time

claude, config, workspace, port, seconds = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
if os.path.realpath(config) == os.path.realpath(os.path.expanduser("~/.claude")):
    sys.exit("refusing to use the real ~/.claude")
os.makedirs(config, exist_ok=True)
# Skip the first-run screens in the temp config (no credentials in it).
state_file = os.path.join(config, ".claude.json")
try:
    with open(state_file) as file:
        state = json.load(file)
except (OSError, ValueError):
    state = {}
state.update({"hasCompletedOnboarding": True, "theme": state.get("theme", "dark")})
state.setdefault("projects", {}).setdefault(workspace, {})["hasTrustDialogAccepted"] = True
with open(state_file, "w") as file:
    json.dump(state, file)
# A temp HOME too: the CLI also looks in (and prunes stale lock files
# from) ~/.claude/ide; the test shouldn't read or change the real one.
home = os.path.join(config, "home")
os.makedirs(home, exist_ok=True)
env = {
    "HOME": home,
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    "TERM": "xterm-256color",
    "LANG": "en_US.UTF-8",
    "CLAUDE_CONFIG_DIR": config,
    "CLAUDE_CODE_SSE_PORT": port,
    "ENABLE_IDE_INTEGRATION": "true",
    "DISABLE_AUTOUPDATER": "1",
}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(workspace)
    os.execve(claude, [claude, "--debug"], env)
print(f"cli pid {pid}", flush=True)
output = b""
started = time.time()
while time.time() - started < seconds:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if not ready:
        continue
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    output += data
    if b"\x1b[6n" in data:  # cursor position query
        os.write(fd, b"\x1b[1;1R")
os.kill(pid, signal.SIGTERM)
time.sleep(0.5)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
screen = re.sub(rb"\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>()][0-9A-Za-z]?", b"", output).decode("utf-8", "replace")
print(screen[-3000:])
