# Gitignore Generator

Adds a ready-made template to your project's `.gitignore`, so build
output, dependencies and OS clutter stay out of Git.

## How to use

1. Open your project folder.
2. Open the command palette: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Gitignore Generator: Add .gitignore Template…**.
4. Pick a template:

   | Template | Ignores |
   | -------- | ------- |
   | Node | `node_modules/`, build output, npm/yarn logs, `.env` |
   | Python | `__pycache__/`, virtualenvs, build output, tool caches |
   | Rust | `target/` |
   | Go | binaries, test output, `vendor/` |
   | Java (Gradle/Maven) | class files, jars, `build/`, `target/` |
   | C/C++ | object files, libraries, executables, CMake output |
   | macOS | `.DS_Store` and other Finder files |
   | Windows | `Thumbs.db`, `Desktop.ini` |
   | Linux | `*~` backups, `.directory`, `.Trash-*` |
   | VS Code | `.vscode/`, keeping shared settings files |
   | JetBrains | `.idea/`, `*.iml` |

5. Sable opens `.gitignore` with the new lines at the end, under a
   heading such as `# Node`.

It creates `.gitignore` if there isn't one. It never adds a line the
file already has (`dist` and `dist/` count as the same), so it's safe to
run again. To combine templates, such as Node and macOS, run the command
once for each.

Permissions: `workspace:read` and `workspace:write` (to read, update and
open `.gitignore`). Needs Sable 0.3.6 or newer.
