//! The deeper Python refactorings — Safe Delete, Change Signature and
//! Move — through Rope (rope_refactorings.py, shipped inside the app).
//! Like `python_refactor`, it runs with the project's interpreter, and
//! Rope comes from Sable's tools folder (`install_rope`) or that
//! interpreter's own packages.
//!
//! One command, a JSON request in and a JSON reply out:
//!
//!   {"file", "kind", "position": [line, utf16 column] | null, "options"}
//!
//! kinds: usages, module_usages, safe_delete, signature,
//! change_signature, move, move_module. Replies carry `files`
//! ([{path, contents}]: whole new contents, nothing is written), and
//! `creates`, `moves`, `conflicts`, `usages`, `symbol` as the kind needs.

use crate::lsp::tools_dir;
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const SCRIPT: &str = include_str!("rope_refactorings.py");

/// Run one of the deeper Rope refactorings (see the module docs).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn python_rope_refactor(python: Option<String>, root: String, request: Value) -> Result<Value, String> {
    let python = python
        .filter(|python| Path::new(python).exists())
        .unwrap_or_else(|| "python3".to_string());
    // -I: the project's modules can't shadow the script's imports.
    let script = format!(
        "import os, sys\npath = os.environ.get('SABLE_ROPE_PATH')\nif path: sys.path.insert(0, path)\n{SCRIPT}"
    );
    let mut command = Command::new(&python);
    command
        .args(["-I", "-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = tools_dir().map(|dir| dir.join("rope")).filter(|dir| dir.exists()) {
        command.env("SABLE_ROPE_PATH", dir);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not run {python}: {error}"))?;
    let mut request = request;
    request["root"] = Value::String(root);
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(request.to_string().as_bytes()).await;
    }
    let output = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .map_err(|_| "The refactoring took too long".to_string())?
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let reply: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("Rope failed: {}", stderr.lines().last().unwrap_or("no output"))
    })?;
    if let Some(error) = reply["error"].as_str() {
        return Err(error.to_string());
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// A small multi-file project.
    fn sample(dir: &Path) {
        let files = [
            ("app/__init__.py", ""),
            (
                "app/pricing.py",
                "\"\"\"Pricing helpers.\"\"\"\nimport math\nfrom decimal import Decimal\n\n\n\
def total(prices: list[float], tax: float, discount: float = 0) -> float:\n    \"\"\"Sum with tax.\"\"\"\n    return math.ceil((sum(prices) - discount) * (1 + tax))\n\n\n\
# Doubles a number.\ndef unused_helper(x):\n    return x * 2\n\n\n\
def used_helper(x):\n    return Decimal(x) + 1\n\n\n\
class Cart:\n    def add(self, item, qty=1):\n        return [item] * qty\n",
            ),
            (
                "app/main.py",
                "from app.pricing import total, used_helper, Cart\n\n\n\
def run():\n    a = total([1, 2], 0.2)\n    b = total(prices=[3], tax=0.1, discount=1)\n    c = total(total([1], 0), 0)\n    cart = Cart()\n    cart.add(\"x\", qty=2)\n    return a, b, c, used_helper(3)\n",
            ),
        ];
        for (path, contents) in files {
            let path = dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
    }

    fn contents_of<'a>(reply: &'a Value, path: &Path) -> &'a str {
        reply["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["path"].as_str() == Some(path.to_str().unwrap()))
            .and_then(|file| file["contents"].as_str())
            .unwrap_or_else(|| panic!("{} not changed: {reply}", path.display()))
    }

    /// Needs an interpreter with Rope: SABLE_TEST_ROPE_PYTHON (a virtualenv
    /// with `pip install rope`).
    #[tokio::test]
    async fn rope_deep_refactorings() {
        let Ok(python) = std::env::var("SABLE_TEST_ROPE_PYTHON") else {
            eprintln!("skipping: set SABLE_TEST_ROPE_PYTHON to a Python with Rope");
            return;
        };
        let dir = std::env::temp_dir().join(format!("sable-rope-deep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        sample(&dir);
        let root = dir.to_string_lossy().into_owned();
        let pricing = dir.join("app/pricing.py");
        let main = dir.join("app/main.py");
        let before = (std::fs::read_to_string(&pricing).unwrap(), std::fs::read_to_string(&main).unwrap());
        let run = |request: Value| python_rope_refactor(Some(python.clone()), root.clone(), request);
        let file = |path: &PathBuf| path.to_string_lossy().into_owned();

        // The signature, read from a call site.
        let info = run(json!({ "file": file(&main), "kind": "signature", "position": [5, 9] })).await.unwrap();
        assert_eq!(info["name"], "total");
        assert_eq!(info["params"][2]["default"], "0");
        assert_eq!(info["returnType"], "float");

        // Change Signature: reorder, rename a parameter, remove one, add one
        // with a default, rename the function, change the return type.
        let reply = run(json!({
            "file": file(&pricing), "kind": "change_signature", "position": [6, 5],
            "options": {
                "name": "total_price",
                "params": [
                    { "name": "rate", "annotation": "float", "original": 1, "kind": "positional" },
                    { "name": "prices", "annotation": "list[float]", "original": 0, "kind": "positional" },
                    { "name": "currency", "annotation": "str", "default": "\"EUR\"", "original": null, "kind": "positional" },
                ],
                "returnType": "int",
            },
        }))
        .await
        .unwrap();
        let new_pricing = contents_of(&reply, &pricing);
        assert!(new_pricing.contains("def total_price(rate: float, prices: list[float], currency: str = \"EUR\") -> int:"), "{new_pricing}");
        assert!(new_pricing.contains("(1 + rate)"), "the body uses the new name: {new_pricing}");
        let new_main = contents_of(&reply, &main);
        assert!(new_main.contains("from app.pricing import total_price, used_helper, Cart"), "{new_main}");
        assert!(new_main.contains("a = total_price(0.2, [1, 2])"), "{new_main}");
        // Keyword arguments: renamed, the removed one dropped.
        assert!(new_main.contains("b = total_price(rate=0.1, prices=[3])"), "{new_main}");
        // Nested calls.
        assert!(new_main.contains("c = total_price(0, total_price(0, [1]))"), "{new_main}");
        // `discount` is still used in the body: reported.
        assert!(reply["conflicts"].to_string().contains("discount"), "{reply}");

        // A method: reorder, keyword-only parameter added with a call-site value.
        let reply = run(json!({
            "file": file(&main), "kind": "change_signature", "position": [9, 10],
            "options": { "params": [
                { "name": "qty", "default": "1", "original": 1, "kind": "positional" },
                { "name": "item", "default": "None", "original": 0, "kind": "positional" },
                { "name": "note", "original": null, "kind": "kwonly", "value": "\"gift\"" },
            ] },
        }))
        .await
        .unwrap();
        assert!(contents_of(&reply, &pricing).contains("def add(self, qty=1, item=None, *, note):"), "{reply}");
        assert!(contents_of(&reply, &main).contains("cart.add(qty=2, item=\"x\", note=\"gift\")"), "{reply}");

        // Safe Delete: a function nobody uses goes, with its comment.
        let usages = run(json!({ "file": file(&pricing), "kind": "usages", "position": [12, 6] })).await.unwrap();
        assert_eq!(usages["usages"].as_array().unwrap().len(), 0, "{usages}");
        let reply = run(json!({ "file": file(&pricing), "kind": "safe_delete", "position": [12, 6] })).await.unwrap();
        let text = contents_of(&reply, &pricing);
        assert!(!text.contains("unused_helper") && !text.contains("Doubles"), "{text}");
        assert!(text.contains("    return math.ceil((sum(prices) - discount) * (1 + tax))\n\n\ndef used_helper(x):"), "{text}");
        // One that is used: its usages, in another file.
        let usages = run(json!({ "file": file(&pricing), "kind": "usages", "position": [16, 6] })).await.unwrap();
        let found = usages["usages"].as_array().unwrap();
        assert_eq!(found.len(), 2, "the import and the call: {usages}");
        assert!(found.iter().all(|usage| usage["path"].as_str() == Some(main.to_str().unwrap())));
        assert_eq!(found[1]["line"], 10);
        // The module's importers (deleting the file).
        let importers = run(json!({ "file": file(&pricing), "kind": "module_usages" })).await.unwrap();
        assert_eq!(importers["usages"].as_array().unwrap().len(), 1, "{importers}");
        // A parameter: removed with its arguments.
        let reply = run(json!({ "file": file(&pricing), "kind": "safe_delete", "position": [6, 32] })).await.unwrap();
        assert!(contents_of(&reply, &main).contains("b = total(prices=[3], discount=1)"), "{reply}");

        // Move a function to another (new) module: imports follow it.
        let target = dir.join("app/helpers.py");
        let reply = run(json!({
            "file": file(&pricing), "kind": "move", "position": [16, 6],
            "options": { "target": file(&target) },
        }))
        .await
        .unwrap();
        let moved = contents_of(&reply, &target);
        assert!(moved.contains("from decimal import Decimal") && moved.contains("def used_helper(x):"), "{moved}");
        let source = contents_of(&reply, &pricing);
        assert!(!source.contains("def used_helper") && !source.contains("Decimal"), "unused import removed: {source}");
        let user = contents_of(&reply, &main);
        assert!(user.contains("used_helper(3)") && user.contains("from app.helpers import used_helper"), "{user}");
        assert_eq!(reply["creates"][0], file(&target));
        assert!(!target.exists(), "nothing written");

        // Rename a module: its importers follow.
        let reply = run(json!({ "file": file(&pricing), "kind": "move_module", "options": { "target": file(&dir.join("app/prices.py")) } }))
            .await
            .unwrap();
        assert!(contents_of(&reply, &main).contains("from app.prices import total, used_helper, Cart"), "{reply}");
        assert_eq!(reply["moves"][0]["to"], file(&dir.join("app/prices.py")));

        // Errors are messages.
        let error = run(json!({ "file": file(&pricing), "kind": "change_signature", "position": [2, 3], "options": { "params": [] } }))
            .await
            .unwrap_err();
        assert!(!error.is_empty());

        // Nothing on disk changed.
        assert_eq!(std::fs::read_to_string(&pricing).unwrap(), before.0);
        assert_eq!(std::fs::read_to_string(&main).unwrap(), before.1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
