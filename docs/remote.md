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

Sable reconnects to the same folder the next time it starts. **Remote:
Close Remote Connection** goes back to this computer.

## SSH

Sable runs your own `ssh`, so everything in `~/.ssh/config` applies —
`HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, and so on — and
keys loaded in your SSH agent work.

Sable connects with **keys, not passwords** (it has no terminal to type
a password into). If a host asks for a password, set up a key once:

```sh
ssh-keygen -t ed25519      # if you don't have a key yet
ssh-copy-id user@host
```

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
statically linked) and macOS.

## Language servers and tools

Language servers, formatters, git and your project's tools run on the
remote, so they need to be installed **there**: `rust-analyzer` for
Rust, `pyright`/`basedpyright` for Python, and so on. Sable's install
buttons install them on the remote.

## Not yet

- Debugging (Run works, on the remote).
- Password and two-factor SSH logins.
- Windows machines as SSH remotes.

## How it works

`src-tauri/src/remote.rs` starts the agent with `ssh host sh -c …` (or
`wsl.exe -d <distro> -e sh -c …`, or `docker exec -i <container> sh -c
…`). If it isn't installed yet, the remote answers with its OS and
processor, and Sable uploads the matching `sable-agent-<platform>.gz`.
The agent (`src-tauri/agent/`, built from `src-tauri/src/agent.rs`)
then reads one JSON request per line on stdin and writes replies and
events on stdout. In the frontend, `src/lib/backend.ts` decides per
command whether it runs locally or on the remote.
