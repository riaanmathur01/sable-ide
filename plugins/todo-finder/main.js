// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const TAGS = /\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s-]*(.*)/;
/** FIXME/BUG read as warnings; the rest as notes. */
const SEVERITY = { FIXME: "warning", BUG: "warning", HACK: "warning", TODO: "info", XXX: "info" };

/** @param {Sable} sable */
export async function activate(sable) {
  let shown = 0;
  const scan = async () => {
    const editor = await sable.editor.active();
    if (!editor) return;
    const diagnostics = [];
    editor.text.split("\n").forEach((line, index) => {
      const match = TAGS.exec(line);
      if (!match) return;
      const column = (match.index ?? 0) + 1;
      diagnostics.push({
        line: index + 1,
        column,
        endColumn: line.length + 1,
        message: `${match[1]}: ${match[2].replace(/\s*(\*\/|-->|#\})\s*$/, "").trim() || "(no description)"}`,
        severity: SEVERITY[match[1]],
        source: "TODO Finder",
      });
    });
    shown = diagnostics.length;
    await sable.languages.setDiagnostics(editor.path, diagnostics);
  };
  sable.events.onDidOpen(scan);
  sable.events.onDidSave(scan);
  sable.commands.register("scan", "Find TODOs in This File", async () => {
    await scan();
    await sable.window.showMessage(shown ? `${shown} TODO${shown === 1 ? "" : "s"} — see Problems` : "No TODOs in this file");
  });
  sable.commands.register("clear", "Clear TODO Marks", () => sable.languages.clearDiagnostics());
  await scan();
}
