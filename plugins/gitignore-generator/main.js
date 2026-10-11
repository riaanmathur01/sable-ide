// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** Each template: what it covers (shown in the list) and its lines. */
const TEMPLATES = [
  {
    name: "Node",
    covers: "node_modules, build output, logs, .env",
    lines: ["node_modules/", "dist/", "build/", ".next/", "coverage/", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*", "pnpm-debug.log*", ".npm/", ".eslintcache", ".env", ".env.local", "*.tsbuildinfo"],
  },
  {
    name: "Python",
    covers: "__pycache__, virtualenvs, build output, caches",
    lines: ["__pycache__/", "*.py[cod]", "*.egg-info/", "dist/", "build/", ".venv/", "venv/", "env/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".coverage", "htmlcov/", ".ipynb_checkpoints/", ".env"],
  },
  { name: "Rust", covers: "target, backup files", lines: ["target/", "**/*.rs.bk", "*.pdb"] },
  { name: "Go", covers: "binaries, test output, vendor", lines: ["*.exe", "*.exe~", "*.dll", "*.so", "*.dylib", "*.test", "*.out", "go.work", "vendor/"] },
  {
    name: "Java (Gradle/Maven)",
    covers: "class files, jars, build and target folders",
    lines: ["*.class", "*.jar", "*.war", "*.ear", "*.log", "hs_err_pid*", ".gradle/", "build/", "!gradle/wrapper/gradle-wrapper.jar", "target/", ".mvn/wrapper/maven-wrapper.jar"],
  },
  {
    name: "C/C++",
    covers: "object files, libraries, executables, CMake output",
    lines: ["*.o", "*.obj", "*.a", "*.lib", "*.so", "*.dylib", "*.dll", "*.exe", "*.out", "*.d", "build/", "CMakeFiles/", "CMakeCache.txt", "cmake-build-*/", "compile_commands.json"],
  },
  { name: "macOS", covers: ".DS_Store and other Finder files", lines: [".DS_Store", ".AppleDouble", ".LSOverride", "._*", ".Spotlight-V100", ".Trashes"] },
  { name: "Windows", covers: "Thumbs.db, desktop.ini, shortcuts", lines: ["Thumbs.db", "Thumbs.db:encryptable", "ehthumbs.db", "Desktop.ini", "$RECYCLE.BIN/", "*.lnk"] },
  { name: "Linux", covers: "editor backups, .directory, .Trash", lines: ["*~", ".fuse_hidden*", ".directory", ".Trash-*", ".nfs*"] },
  {
    name: "VS Code",
    covers: ".vscode (keeping shared settings)",
    lines: [".vscode/*", "!.vscode/settings.json", "!.vscode/tasks.json", "!.vscode/launch.json", "!.vscode/extensions.json", "*.code-workspace", ".history/"],
  },
  { name: "JetBrains", covers: ".idea, *.iml, out", lines: [".idea/", "*.iml", "*.iws", "*.ipr", "out/"] },
];

/** A line as compared for duplicates: "node_modules/ " and "node_modules" match. */
const normalize = (line) => line.trim().replace(/\/+$/, "");

/**
 * `existing` with the template's lines it doesn't have yet appended under
 * a "# Name" heading, or null if it has them all.
 */
function appendTemplate(existing, template) {
  const present = new Set(existing.split(/\r?\n/).map(normalize).filter(Boolean));
  const missing = template.lines.filter((line) => !present.has(normalize(line)));
  if (!missing.length) return null;
  let text = existing;
  if (text && !text.endsWith("\n")) text += "\n";
  if (text.trim()) text += "\n";
  return `${text}# ${template.name}\n${missing.join("\n")}\n`;
}

/** @param {Sable} sable */
export function activate(sable) {
  sable.commands.register("add", "Add .gitignore Template…", async () => {
    if (!sable.workspace.root) return sable.window.showError("Open a folder first");
    const choice = await sable.window.showQuickPick(
      TEMPLATES.map((template) => ({ label: template.name, description: template.covers, template })),
      { placeholder: "Add which template to .gitignore?" },
    );
    if (!choice) return;

    let existing = "";
    try {
      existing = await sable.workspace.readFile(".gitignore");
    } catch (error) {
      // No .gitignore yet: start one. Anything else, don't risk overwriting it.
      if (!/not found/i.test(String(error))) throw error;
    }

    const updated = appendTemplate(existing, choice.template);
    if (updated === null) {
      await sable.window.showMessage(`.gitignore already has everything in the ${choice.template.name} template`);
    } else {
      await sable.workspace.writeFile(".gitignore", updated);
      await sable.window.showMessage(`Added the ${choice.template.name} template to .gitignore`);
    }
    await sable.editor.open(".gitignore");
  });
}
