//! VS Code color themes (`contributes.themes`) for converted extensions:
//! each theme's file read the way VS Code reads it — JSON with comments,
//! `include`d base themes merged in, and TextMate `.tmTheme` (plist)
//! files — and written out as one plain JSON file the frontend turns into
//! a Sable theme (src/lib/vscodeTheme.ts).

use crate::plugins::ThemeContribution;
use serde_json::{json, Map, Value};
use std::path::Path;

/// How deep `include` chains may go (they can't loop forever).
const MAX_INCLUDE_DEPTH: usize = 8;

/// The extension's themes: each contribution (its file under `themes/`
/// in the plugin) and the theme JSON to write there.
pub fn contributed_themes(root: &Path, package: &Value, plugin_id: &str) -> Vec<(ThemeContribution, Value)> {
    let Some(Value::Array(list)) = package.pointer("/contributes/themes") else {
        return Vec::new();
    };
    let mut themes = Vec::new();
    let mut used = std::collections::HashSet::new();
    for contribution in list {
        let (Some(label), Some(path)) = (
            contribution.get("label").and_then(Value::as_str),
            contribution.get("path").and_then(Value::as_str),
        ) else {
            continue;
        };
        let Some(theme) = load_theme(&root.join(path.trim_start_matches("./")), 0) else {
            continue;
        };
        let mut slug = slugify(contribution.get("id").and_then(Value::as_str).unwrap_or(label));
        if slug.is_empty() {
            slug = "theme".into();
        }
        while !used.insert(slug.clone()) {
            slug.push('-');
        }
        let ui_theme = contribution.get("uiTheme").and_then(Value::as_str).unwrap_or("vs-dark").to_string();
        themes.push((
            ThemeContribution {
                // Letters, digits and dashes (all Monaco allows in a theme name).
                id: format!("{}-{slug}", slugify(plugin_id)),
                label: label.to_string(),
                ui_theme,
                path: format!("themes/{slug}.json"),
            },
            theme,
        ));
    }
    themes
}

fn slugify(text: &str) -> String {
    let mut slug = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    slug.trim_end_matches('-').to_string()
}

/// A theme file, with what it includes merged in (VS Code's order: the
/// included theme first, this one's colors and rules on top).
fn load_theme(path: &Path, depth: usize) -> Option<Value> {
    if depth > MAX_INCLUDE_DEPTH {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let lower = path.to_string_lossy().to_lowercase();
    if lower.ends_with(".tmtheme") || text.trim_start().starts_with("<?xml") || text.trim_start().starts_with("<plist") {
        return tm_theme(&parse_plist(&text)?);
    }
    let mut theme = crate::devcontainer::parse_jsonc(&text).ok()?;
    if !theme.is_object() {
        return None;
    }
    // tokenColors can name a file (a .tmTheme, or JSON with the rules).
    if let Some(Value::String(file)) = theme.get("tokenColors").cloned() {
        let file = path.parent()?.join(file.trim_start_matches("./"));
        let rules = load_theme(&file, depth + 1)
            .and_then(|loaded| loaded.get("tokenColors").cloned())
            .or_else(|| {
                // A JSON file that's just the list of rules.
                let text = std::fs::read_to_string(&file).ok()?;
                crate::devcontainer::parse_jsonc(&text).ok().filter(Value::is_array)
            })
            .unwrap_or(json!([]));
        theme["tokenColors"] = rules;
    }
    let include = theme.get("include").and_then(Value::as_str).map(str::to_string);
    let Some(include) = include else {
        return Some(theme);
    };
    let base = load_theme(&path.parent()?.join(include.trim_start_matches("./")), depth + 1).unwrap_or(json!({}));
    Some(merge(base, theme))
}

/// `theme` on top of `base`: colors and semantic colors key by key, token
/// rules appended (later rules win).
fn merge(base: Value, theme: Value) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    for (key, value) in theme.as_object().cloned().unwrap_or_default() {
        match key.as_str() {
            "include" => {}
            "colors" | "semanticTokenColors" => {
                let mut combined = merged.get(&key).and_then(Value::as_object).cloned().unwrap_or_default();
                for (name, color) in value.as_object().cloned().unwrap_or_default() {
                    combined.insert(name, color);
                }
                merged.insert(key, Value::Object(combined));
            }
            "tokenColors" => {
                let mut rules = merged.get(&key).and_then(Value::as_array).cloned().unwrap_or_default();
                rules.extend(value.as_array().cloned().unwrap_or_default());
                merged.insert(key, Value::Array(rules));
            }
            _ => {
                merged.insert(key, value);
            }
        }
    }
    Value::Object(merged)
}

/// A TextMate theme (plist, as JSON) as a VS Code theme: its rules are
/// tokenColors, and its scope-less first rule holds the editor's colors.
fn tm_theme(plist: &Value) -> Option<Value> {
    let settings = plist.get("settings")?.as_array()?;
    let mut colors = Map::new();
    let mut rules = Vec::new();
    for rule in settings {
        let Some(style) = rule.get("settings").and_then(Value::as_object) else {
            continue;
        };
        if rule.get("scope").is_none() {
            for (from, to) in [
                ("background", "editor.background"),
                ("foreground", "editor.foreground"),
                ("caret", "editorCursor.foreground"),
                ("selection", "editor.selectionBackground"),
                ("lineHighlight", "editor.lineHighlightBackground"),
                ("invisibles", "editorWhitespace.foreground"),
                ("findHighlight", "editor.findMatchHighlightBackground"),
                ("guide", "editorIndentGuide.background1"),
                ("activeGuide", "editorIndentGuide.activeBackground1"),
            ] {
                if let Some(color) = style.get(from).and_then(Value::as_str) {
                    colors.insert(to.into(), json!(color));
                }
            }
            continue;
        }
        let mut kept = Map::new();
        for key in ["foreground", "background", "fontStyle"] {
            if let Some(value) = style.get(key) {
                kept.insert(key.into(), value.clone());
            }
        }
        rules.push(json!({ "scope": rule["scope"], "settings": kept }));
    }
    Some(json!({ "colors": colors, "tokenColors": rules }))
}

/// An XML property list (as .tmTheme files are) as JSON: dict, array,
/// string, integer, real, true and false. None if it isn't one.
pub fn parse_plist(text: &str) -> Option<Value> {
    let mut parser = Plist { text, at: 0 };
    let start = text.find("<plist")?;
    parser.at = start + text[start..].find('>')? + 1;
    parser.value()
}

struct Plist<'a> {
    text: &'a str,
    at: usize,
}

impl Plist<'_> {
    /// The next tag's name (skipping text, comments and declarations),
    /// with whether it's self-closing (`<true/>`) or a closing tag.
    fn tag(&mut self) -> Option<(String, bool, bool)> {
        loop {
            let rest = &self.text[self.at..];
            let open = rest.find('<')?;
            self.at += open;
            let rest = &self.text[self.at..];
            if rest.starts_with("<!--") {
                self.at += rest.find("-->")? + 3;
                continue;
            }
            if rest.starts_with("<?") || rest.starts_with("<!") {
                self.at += rest.find('>')? + 1;
                continue;
            }
            let close = rest.find('>')?;
            let inner = &rest[1..close];
            self.at += close + 1;
            let closing = inner.starts_with('/');
            let empty = inner.ends_with('/');
            let name = inner.trim_start_matches('/').trim_end_matches('/').split_whitespace().next()?.to_string();
            return Some((name, closing, empty));
        }
    }

    /// The text up to `</name>`, entities decoded.
    fn text_until(&mut self, name: &str) -> Option<String> {
        let end_tag = format!("</{name}>");
        let rest = &self.text[self.at..];
        let end = rest.find(&end_tag)?;
        let raw = &rest[..end];
        self.at += end + end_tag.len();
        Some(decode(raw))
    }

    fn value(&mut self) -> Option<Value> {
        let (name, closing, empty) = self.tag()?;
        if closing {
            return None;
        }
        self.value_of(&name, empty)
    }

    fn value_of(&mut self, name: &str, empty: bool) -> Option<Value> {
        match name {
            "dict" => {
                let mut map = Map::new();
                if empty {
                    return Some(Value::Object(map));
                }
                loop {
                    let (tag, closing, _) = self.tag()?;
                    if closing && tag == "dict" {
                        return Some(Value::Object(map));
                    }
                    if tag != "key" {
                        return None;
                    }
                    let key = self.text_until("key")?;
                    let (value_tag, closing, empty) = self.tag()?;
                    if closing {
                        return None;
                    }
                    map.insert(key, self.value_of(&value_tag, empty)?);
                }
            }
            "array" => {
                let mut list = Vec::new();
                if empty {
                    return Some(Value::Array(list));
                }
                loop {
                    let (tag, closing, empty) = self.tag()?;
                    if closing && tag == "array" {
                        return Some(Value::Array(list));
                    }
                    list.push(self.value_of(&tag, empty)?);
                }
            }
            "string" | "date" | "data" => Some(Value::String(if empty { String::new() } else { self.text_until(name)? })),
            "integer" => Some(json!(self.text_until(name)?.trim().parse::<i64>().ok()?)),
            "real" => Some(json!(self.text_until(name)?.trim().parse::<f64>().ok()?)),
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        }
    }
}

fn decode(text: &str) -> String {
    let text = text.strip_prefix("<![CDATA[").and_then(|rest| rest.strip_suffix("]]>")).unwrap_or(text);
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_tm_theme() {
        let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>name</key><string>Test &amp; Co</string>
  <!-- a comment -->
  <key>settings</key>
  <array>
    <dict><key>settings</key><dict><key>background</key><string>#101010</string><key>foreground</key><string>#eeeeee</string></dict></dict>
    <dict><key>scope</key><string>comment, punctuation.definition.comment</string>
      <key>settings</key><dict><key>foreground</key><string>#777777</string><key>fontStyle</key><string>italic</string></dict></dict>
    <dict><key>scope</key><string>keyword</string><key>settings</key><dict/></dict>
  </array>
  <key>semanticClass</key><true/>
</dict>
</plist>"#;
        let parsed = parse_plist(plist).unwrap();
        assert_eq!(parsed["name"], "Test & Co");
        assert_eq!(parsed["semanticClass"], true);
        let theme = tm_theme(&parsed).unwrap();
        assert_eq!(theme["colors"]["editor.background"], "#101010");
        assert_eq!(theme["tokenColors"][0]["scope"], "comment, punctuation.definition.comment");
        assert_eq!(theme["tokenColors"][0]["settings"]["fontStyle"], "italic");
        assert_eq!(theme["tokenColors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn merges_includes_and_reads_contributions() {
        let root = std::env::temp_dir().join(format!("sable-vscode-theme-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("themes")).unwrap();
        std::fs::write(
            root.join("themes/base.json"),
            r##"{ "colors": { "editor.background": "#000000", "editor.foreground": "#ffffff" },
                 "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#888888" } } ] }"##,
        )
        .unwrap();
        std::fs::write(
            root.join("themes/night.json"),
            r##"{
              // comments and trailing commas, as in VS Code
              "include": "./base.json",
              "colors": { "editor.background": "#111122", },
              "tokenColors": [ { "scope": "keyword", "settings": { "foreground": "#ff00ff" } } ],
            }"##,
        )
        .unwrap();
        let package = json!({ "contributes": { "themes": [
            { "label": "Night Owl (No Italics)", "uiTheme": "vs-dark", "path": "./themes/night.json" },
            { "label": "Missing", "path": "./themes/missing.json" },
        ] } });
        let themes = contributed_themes(&root, &package, "vscode.t.night");
        assert_eq!(themes.len(), 1);
        let (contribution, theme) = &themes[0];
        assert_eq!(contribution.id, "vscode-t-night-night-owl-no-italics");
        assert_eq!(contribution.path, "themes/night-owl-no-italics.json");
        assert_eq!(theme["colors"]["editor.background"], "#111122");
        assert_eq!(theme["colors"]["editor.foreground"], "#ffffff");
        assert_eq!(theme["tokenColors"].as_array().unwrap().len(), 2);
        assert!(theme.get("include").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
