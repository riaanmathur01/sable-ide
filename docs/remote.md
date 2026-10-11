# Remote development

Sable can open a folder on another machine and work on it as if it were
local: the explorer, editor, search, git, terminal, Run, tasks, tests,
language servers and formatters all run there. Settings, themes,
plugins and the AI agent's keys stay on your computer.

## Connecting

Click the remote button at the far left of the status bar, or use the
command palette (⇧⌘P):

- **Remote: Connect to SSH Host…** lists the hosts in `~/.ssh/config`.
  Pick one, or type `user@host` (or any name `ssh` understands).
- **Remote: Attach to Running Container…** lists running Docker and
  Podman containers.
- **Remote: Connect to WSL…** (Windows) lists your WSL distributions.

Then choose a folder: start from your home folder, go into folders with
Enter, `..` goes up, and you can type a path (`/srv/app`, `~/code`). The
status bar shows where you're connected (for example **SSH: devbox**).

Sable reconnects to the same folder the next time it starts. If the
connection drops (a network blip, a laptop waking up), it reconnects by
itself, keeping your open files; if that fails, the status bar offers
**Reconnect**. **Remote: Close Remote Connection** goes back to this
computer.

## Dev containers

A folder with `.devcontainer/devcontainer.json` can be opened inside its
container: open the folder, then run **Remote: Reopen Folder in
Container**. Sable builds the image (or pulls it), starts a container
with the folder mounted at `/workspaces/<name>` (or the config's
`workspaceFolder`), connects to it, and runs `postCreateCommand` in a
terminal the first time. The container is kept and reused next time.
**Remote: Reopen Folder Locally** goes back.

Sable reads `image`, `build` (`dockerfile`, `context`, `args`),
`workspaceFolder`, `workspaceMount`, `containerEnv`, `runArgs`,
`remoteUser`, `overrideCommand` and `postCreateCommand`. Docker Compose
configs and dev container features aren't supported yet. It needs Docker
or Podman.

## Ports

When a program on the remote starts listening on a port — a dev server,
say — Sable forwards it: it's reachable at `localhost:<port>` on this
computer (another local port if that one is taken), and the status bar
says so. **Ports** in the bottom panel lists them: click one to open it in
the browser, stop forwarding it, or forward any other port (**Forward a
Port…**, also **Remote: Forward a Port…** in the command palette).

Ports already open when you connect, and ports below 1024, aren't
forwarded by themselves. Turn automatic forwarding off in **Settings →
Remote**. Forwarding goes through Sable's own connection, so it works the
same over SSH, WSL and containers.

## Moving files

Drop files or folders onto a remote window to upload them into the open
folder, or right-click a folder in the explorer → **Upload Files Here…**.
Right-click any file or folder → **Download…** to copy it to this
computer. (Up to 2,000 files, 20 MB each, at a time.)

## SSH

Sable runs your own `ssh`, so everything in `~/.ssh/config` applies —
`HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, and so on — and
keys loaded in your SSH agent work.

Keys loaded in your SSH agent are used without asking. If the host wants
a password, your key's passphrase, or a one-time code, Sable asks in a
small dialog and passes the answer straight to `ssh` (it isn't stored).
On macOS and Linux one login is shared by the connection's steps — and
reconnects in the next five minutes — so you're asked once. To skip
passwords altogether, set up a key:

```sh
ssh-keygen -t ed25519      # if you don't have a key yet
ssh-copy-id user@host
```

**Windows machines** work as SSH hosts too (with Windows' OpenSSH
server): Sable notices it's talking to Windows and starts its agent with
PowerShell instead.

A host Sable hasn't seen before is trusted the first time (as answering
"yes" to `ssh` would); a host whose key has *changed* is refused.

## What gets installed on the remote

The first time you connect to a machine with a new version of Sable, it
copies its agent there, in `~/.sable-server/bin/<version>/` (about 11 MB;
4.5 MB to transfer). Sable downloads it on your computer from the GitHub
release and copies it over the connection, so the remote doesn't need
internet access. Local history and tools Sable installs (such as
language servers) live in `~/.sable-server/data/`. Delete
`~/.sable-server` to remove it all.

The agent runs on Linux (x86_64 and ARM64, any distribution: it's
statically linked), macOS, and Windows (x86_64). Sable removes agents of
older versions when it starts a newer one.

## Language servers and tools

Language servers, formatters, git and your project's tools run on the
remote, so they need to be installed **there**: `rust-analyzer` for
Rust, `pyright`/`basedpyright` for Python, and so on. Sable's install
buttons install them on the remote.

## Debugging

Debugging works in remote windows: the debugger (debugpy, js-debug,
CodeLLDB, Delve, java-debug) runs on the remote next to your program, so
install it there — Sable's install buttons do that when you're connected.

## How it works

`src-tauri/src/remote.rs` starts the agent with `ssh host sh -c …` (or
`wsl.exe -d <distro> -e sh -c …`, or `docker exec -i <container> sh -c
…`). If it isn't installed yet, the remote answers with its OS and
processor, and Sable uploads the matching `sable-agent-<platform>.gz`.
The agent (`src-tauri/agent/`, built from `src-tauri/src/agent.rs`)
then reads one JSON request per line on stdin and writes replies and
events on stdout. In the frontend, `src/lib/backend.ts` decides per
command whether it runs locally or on the remote.
