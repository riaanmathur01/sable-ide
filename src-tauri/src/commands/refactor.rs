//! Python refactorings through Rope (the library behind most Python
//! refactoring tools) — Pyright, Sable's Python server, has none. Other
//! languages refactor through their language servers (code actions).
//!
//! Rope is pure Python: Sable installs it into its tools folder
//! (`install_rope`) and runs it with the project's interpreter.

use crate::lsp::tools_dir;
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Reads a request on stdin, runs one Rope refactoring, prints the files
/// it changes. Positions arrive as line + UTF-16 column (the editor's),
/// converted here to Rope's code-point offsets.
const SCRIPT: &str = r#"
import ast, json, os, sys
try:
    from rope.base.project import Project
    from rope.base.exceptions import RopeError
    from rope.refactor.extract import ExtractMethod, ExtractVariable
    from rope.refactor.inline import create_inline
    from rope.base.change import ChangeContents
except ImportError:
    # The frontend recognizes this and offers to install Rope.
    print(json.dumps({"error": "rope-missing"}))
    sys.exit(0)

# Expressions that can be inlined anywhere without brackets.
ATOMIC = (ast.Name, ast.Constant, ast.Attribute, ast.Call, ast.Subscript, ast.List, ast.Dict,
          ast.Set, ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp, ast.JoinedStr)


def bracket_inlined_value(source, offset):
    """Rope inlines a variable's value as written: `x = 2 + 3; x * 2`
    becomes `2 + 3 * 2`. Bracket the value of the assignment being inlined
    (the one at, or the last before, `offset` in its function) so the
    result means the same: `(2 + 3) * 2`."""
    tree = ast.parse(source)
    lines = source.split("\n")
    starts = [0]
    for text in lines:
        starts.append(starts[-1] + len(text) + 1)

    def position(line, byte_column):
        # ast columns are UTF-8 byte offsets.
        return starts[line - 1] + len(lines[line - 1].encode("utf-8")[:byte_column].decode("utf-8"))

    start = offset
    while start > 0 and (source[start - 1].isalnum() or source[start - 1] == "_"):
        start -= 1
    end = offset
    while end < len(source) and (source[end].isalnum() or source[end] == "_"):
        end += 1
    name = source[start:end]
    if not name:
        return source
    # The innermost function (or the module) containing the cursor.
    scope = tree
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if position(node.lineno, node.col_offset) <= offset <= position(node.end_lineno, node.end_col_offset):
                if scope is tree or position(node.lineno, node.col_offset) > position(scope.lineno, scope.col_offset):
                    scope = node
    best = None
    for node in ast.walk(scope):
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name) and node.targets[0].id == name):
            at = position(node.lineno, node.col_offset)
            if at <= offset and (best is None or at > position(best.lineno, best.col_offset)):
                best = node
    if best is None or isinstance(best.value, ATOMIC):
        return source
    value_start = position(best.value.lineno, best.value.col_offset)
    value_end = position(best.value.end_lineno, best.value.end_col_offset)
    return source[:value_start] + "(" + source[value_start:value_end] + ")" + source[value_end:]


request = json.load(sys.stdin)
project = Project(request["root"], ropefolder=None)
try:
    resource = project.get_file(os.path.relpath(request["file"], request["root"]))
    source = resource.read()
    lines = source.split("\n")

    def offset(line, column):
        before = sum(len(text) + 1 for text in lines[: line - 1])
        units = 0
        for index, char in enumerate(lines[line - 1]):
            if units >= column - 1:
                return before + index
            units += 2 if ord(char) > 0xFFFF else 1
        return before + len(lines[line - 1])

    start = offset(*request["start"])
    end = offset(*request["end"])
    kind = request["kind"]
    name = request.get("name")
    if kind == "extract_method":
        changes = ExtractMethod(project, resource, start, end).get_changes(name)
    elif kind == "extract_variable":
        changes = ExtractVariable(project, resource, start, end).get_changes(name)
    elif kind == "extract_constant":
        changes = ExtractVariable(project, resource, start, end).get_changes(name, global_=True)
    elif kind == "inline":
        bracketed = bracket_inlined_value(source, start)
        if bracketed != source:
            resource.write(bracketed)
        try:
            changes = create_inline(project, resource, start).get_changes()
        finally:
            if bracketed != source:
                resource.write(source)
    else:
        raise RopeError("unknown refactoring " + kind)
    files = [
        {"path": change.resource.real_path, "contents": change.new_contents}
        for change in changes.changes
        if isinstance(change, ChangeContents)
    ]
    # Rope can produce broken code for selections it misjudges (e.g.
    # "extracting" an assignment's target): never hand that back.
    for changed in files:
        if changed["path"].endswith((".py", ".pyw")):
            try:
                ast.parse(changed["contents"])
            except SyntaxError:
                raise RopeError("that selection can't be refactored this way")
    print(json.dumps({"files": files}))
except Exception as error:
    print(json.dumps({"error": str(error) or type(error).__name__}))
finally:
    project.close()
"#;

fn rope_dir() -> Option<PathBuf> {
    Some(tools_dir()?.join("rope"))
}

#[derive(Serialize, Debug)]
pub struct FileChange {
    path: String,
    contents: String,
}

/// Run a Rope refactoring on a saved file. `kind`: extract_method,
/// extract_variable, extract_constant or inline; `start`/`end` are
/// [line, column] (1-based, the editor's).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // each is a separate argument from the frontend
pub async fn python_refactor(
    python: Option<String>,
    root: String,
    file: String,
    kind: String,
    start: (u32, u32),
    end: (u32, u32),
    name: Option<String>,
) -> Result<Vec<FileChange>, String> {
    let python = python
        .filter(|python| Path::new(python).exists())
        .unwrap_or_else(|| "python3".to_string());
    // -I (isolated: the project's own modules can't shadow the script's
    // imports) ignores PYTHONPATH, so Rope's folder is added from inside.
    let mut command = Command::new(&python);
    let script = format!(
        "import os, sys\npath = os.environ.get('SABLE_ROPE_PATH')\nif path: sys.path.insert(0, path)\n{SCRIPT}"
    );
    command
        .args(["-I", "-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = rope_dir().filter(|dir| dir.exists()) {
        command.env("SABLE_ROPE_PATH", dir);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not run {python}: {error}"))?;
    let request = json!({ "root": root, "file": file, "kind": kind, "start": start, "end": end, "name": name });
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(request.to_string().as_bytes()).await;
    }
    let output = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| "The refactoring took too long".to_string())?
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let reply: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("Rope failed: {}", stderr.lines().last().unwrap_or("no output"))
    })?;
    if let Some(error) = reply["error"].as_str() {
        return Err(error.to_string());
    }
    Ok(reply["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|file| FileChange {
            path: file["path"].as_str().unwrap_or_default().to_string(),
            contents: file["contents"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

/// Install Rope into Sable's tools folder (pip, into a plain folder: no
/// environment of the user's is touched).
#[tauri::command]
pub async fn install_rope(python: Option<String>) -> Result<(), String> {
    let dir = rope_dir().ok_or("No tools folder")?;
    let python = python
        .filter(|python| Path::new(python).exists())
        .unwrap_or_else(|| "python3".to_string());
    let output = Command::new(&python)
        .args(["-m", "pip", "install", "--quiet", "--upgrade", "--target"])
        .arg(&dir)
        .arg("rope")
        .output()
        .await
        .map_err(|error| format!("Could not run {python}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Installing Rope failed: {}", stderr.trim().lines().last().unwrap_or("")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rope_refactorings() {
        if let Some(home) = std::env::var_os("HOME") {
            crate::lsp::set_tools_dir(PathBuf::from(home).join("Library/Application Support/com.riaanmathur.sable/tools"));
        }
        if !rope_dir().is_some_and(|dir| dir.exists()) {
            if std::env::var("SABLE_TEST_INSTALL_ROPE").is_err() {
                eprintln!("skipping: Rope isn't installed (set SABLE_TEST_INSTALL_ROPE=1)");
                return;
            }
            install_rope(None).await.unwrap();
        }
        let dir = std::env::temp_dir().join(format!("sable-rope-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let file = dir.join("sample.py");
        let source = "def main():\n    total = 0\n    for i in range(5):\n        total += i * 2\n    print(\"total\", total)  # é😀\n";
        let root = dir.to_string_lossy().into_owned();
        let path = file.to_string_lossy().into_owned();
        let run = |kind: &'static str, start: (u32, u32), end: (u32, u32), name: Option<&'static str>| {
            std::fs::write(&file, source).unwrap();
            let (root, path) = (root.clone(), path.clone());
            async move {
                python_refactor(None, root, path, kind.into(), start, end, name.map(String::from)).await
            }
        };

        let changes = run("extract_variable", (4, 18), (4, 23), Some("doubled")).await.unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].contents.contains("        doubled = i * 2\n        total += doubled\n"), "{}", changes[0].contents);

        let changes = run("extract_method", (3, 5), (4, 23), Some("add_up")).await.unwrap();
        let text = &changes[0].contents;
        assert!(text.contains("def add_up(total):"), "{text}");
        assert!(text.contains("total = add_up(total)"), "{text}");

        let changes = run("extract_constant", (3, 20), (3, 21), Some("COUNT")).await.unwrap();
        let text = &changes[0].contents;
        assert!(text.contains("COUNT = 5") && text.contains("range(COUNT)"), "{text}");

        // Inline `total`'s initial value? Inline a variable used once:
        std::fs::write(&file, "def f():\n    x = 2 + 3\n    return x * 2\n").unwrap();
        let changes = python_refactor(None, root.clone(), path.clone(), "inline".into(), (2, 5), (2, 5), None).await.unwrap();
        assert_eq!(changes[0].contents, "def f():\n    return (2 + 3) * 2\n");
        // A plain value isn't bracketed; other code isn't touched.
        std::fs::write(&file, "def f():\n    x = g(1)\n    y = 1 + 1\n    return x * y\n").unwrap();
        let changes = python_refactor(None, root.clone(), path.clone(), "inline".into(), (4, 12), (4, 12), None).await.unwrap();
        assert_eq!(changes[0].contents, "def f():\n    y = 1 + 1\n    return g(1) * y\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "def f():\n    x = g(1)\n    y = 1 + 1\n    return x * y\n");

        // Column positions after a non-BMP character are UTF-16 units.
        std::fs::write(&file, "s = '😀'; t = 1 + 2\n").unwrap();
        let changes = python_refactor(None, root.clone(), path.clone(), "extract_variable".into(), (1, 15), (1, 20), Some("n".into())).await.unwrap();
        assert!(changes[0].contents.contains("n = 1 + 2"), "{}", changes[0].contents);

        let error = python_refactor(None, root, path, "extract_method".into(), (1, 1), (1, 2), Some("x".into())).await.unwrap_err();
        assert!(!error.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
