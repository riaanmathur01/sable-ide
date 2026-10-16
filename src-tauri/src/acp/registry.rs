//! The ACP registry (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json,
//! format: github.com/agentclientprotocol/registry FORMAT.md): which coding
//! agents exist and how to get each one — an npm package run with Node
//! (`npx`), a per-platform archive (`binary`), or a PyPI package (`uvx`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub agents: Vec<AgentEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, alias = "license_url", skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub distribution: Distribution,
    /// "sable" for agents Sable lists itself (not in the ACP registry).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Distribution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<BTreeMap<String, BinaryTarget>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npx: Option<PackageDistribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uvx: Option<PackageDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PackageDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// How an agent will be installed on this platform.
#[derive(Debug, Clone, PartialEq)]
pub enum Method<'a> {
    Binary(&'a BinaryTarget),
    Npx(&'a PackageDistribution),
    Uvx(&'a PackageDistribution),
}

impl Method<'_> {
    pub fn kind(&self) -> &'static str {
        match self {
            Method::Binary(_) => "binary",
            Method::Npx(_) => "npx",
            Method::Uvx(_) => "uvx",
        }
    }
}

pub fn parse(text: &str) -> Result<Registry, String> {
    let registry: Registry = serde_json::from_str(text).map_err(|error| format!("The agent registry isn't valid: {error}"))?;
    if let Some(bad) = registry.agents.iter().find(|agent| !valid_id(&agent.id)) {
        return Err(format!("The agent registry has an invalid id: {:?}", bad.id));
    }
    Ok(registry)
}

/// Ids become folder names: keep them plain.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && !id.starts_with('.')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The registry's platform name for an OS and CPU (Rust's names).
pub fn platform_for(os: &str, arch: &str) -> Option<String> {
    let os = match os {
        "macos" | "darwin" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match arch {
        "aarch64" | "arm64" => "aarch64",
        "x86_64" | "amd64" | "x64" => "x86_64",
        _ => return None,
    };
    Some(format!("{os}-{arch}"))
}

/// This machine's platform name (`darwin-aarch64`, …).
pub fn platform() -> Option<String> {
    platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// The way to install `entry` here: its archive for this platform if it
/// has one (no Node needed), else its npm package, else its PyPI one.
pub fn method<'a>(entry: &'a AgentEntry, platform: Option<&str>) -> Result<Method<'a>, String> {
    if let (Some(binaries), Some(platform)) = (&entry.distribution.binary, platform) {
        if let Some(target) = binaries.get(platform) {
            return Ok(Method::Binary(target));
        }
    }
    if let Some(npx) = &entry.distribution.npx {
        return Ok(Method::Npx(npx));
    }
    if let Some(uvx) = &entry.distribution.uvx {
        return Ok(Method::Uvx(uvx));
    }
    let platforms: Vec<&String> = entry.distribution.binary.iter().flat_map(|binaries| binaries.keys()).collect();
    Err(if platforms.is_empty() {
        format!("{} has no way to install it", entry.name)
    } else {
        format!(
            "{} isn't available for {} (it's built for {})",
            entry.name,
            platform.unwrap_or("this platform"),
            platforms.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(", ")
        )
    })
}

/// Whether installing `entry` downloads proprietary software straight from
/// its vendor (Cursor's CLI): Sable asks first, says whose terms apply, and
/// never installs it otherwise.
pub fn needs_consent(entry: &AgentEntry) -> bool {
    entry.license.as_deref().is_some_and(|license| license.eq_ignore_ascii_case("proprietary")) && entry.distribution.binary.is_some() && entry.distribution.npx.is_none()
}

/// `@scope/name@1.2.3` → (`@scope/name`, Some("1.2.3")).
pub fn split_package(spec: &str) -> (&str, Option<&str>) {
    let search_from = usize::from(spec.starts_with('@'));
    match spec[search_from..].find('@') {
        Some(at) => {
            let at = at + search_from;
            (&spec[..at], Some(&spec[at + 1..]).filter(|version| !version.is_empty()))
        }
        None => (spec, None),
    }
}

/// Whether `candidate` is a newer version than `current` (dotted numbers,
/// a prerelease sorting before its release). Unparseable: different = newer.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (semver::Version::parse(candidate.trim_start_matches('v')), semver::Version::parse(current.trim_start_matches('v'))) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => {
            let numbers = |text: &str| -> Vec<u64> { text.split(|c: char| !c.is_ascii_digit()).filter_map(|part| part.parse().ok()).collect() };
            let (a, b) = (numbers(candidate), numbers(current));
            if a.is_empty() || b.is_empty() {
                candidate != current
            } else {
                a > b
            }
        }
    }
}

/// Built in, for when the registry can't be reached the first time: the
/// agents Sable features, at versions known to work.
pub const FALLBACK: &str = include_str!("fallback_registry.json");

/// Agents that aren't in the ACP registry but Sable offers anyway, in the
/// registry's own format (an npm package + its bin, or archives). E.g.
///   {"id": "kimi-code", "name": "Kimi Code", "version": "2.2.0", "description": "…",
///    "distribution": {"npx": {"package": "@moonshot-ai/kimi-code@2.2.0", "args": ["acp"]}}}
pub const EXTRA: &str = include_str!("extra_agents.json");

/// Claude Code, run from the user's own `claude` CLI (not downloaded: see
/// claude_code.rs). Listed so the cards and the picker show it.
pub fn claude_code_entry() -> AgentEntry {
    AgentEntry {
        id: super::claude_code::ID.into(),
        name: "Claude Code".into(),
        version: String::new(),
        description: "Runs your installed claude CLI (Anthropic's Claude Code) with your own sign-in.".into(),
        repository: None,
        website: Some("https://code.claude.com/docs/en/setup".into()),
        authors: vec!["Anthropic".into()],
        license: Some("proprietary".into()),
        license_url: Some("https://code.claude.com/docs/en/legal-and-compliance".into()),
        icon: None,
        distribution: Distribution::default(),
        source: Some("cli".into()),
    }
}

/// Add Sable's own entries to a registry (a registry entry with the same
/// id wins: it's newer).
pub fn with_extras(mut registry: Registry, extras: &str) -> Registry {
    registry.agents.retain(|agent| agent.id != super::claude_code::ID);
    registry.agents.push(claude_code_entry());
    if let Ok(extra) = parse(extras) {
        for mut entry in extra.agents {
            if !registry.agents.iter().any(|agent| agent.id == entry.id) {
                entry.source = Some("sable".into());
                registry.agents.push(entry);
            }
        }
    }
    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "version": "1.0.0",
      "agents": [
        { "id": "claude-acp", "name": "Claude Agent", "version": "0.90.0", "description": "ACP wrapper for Anthropic's Claude",
          "authors": ["Anthropic"], "license": "proprietary", "license_url": "https://example.com/LICENSE",
          "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg",
          "distribution": { "npx": { "package": "@agentclientprotocol/claude-agent-acp@0.90.0" } } },
        { "id": "kimi", "name": "Kimi CLI", "version": "1.52.0", "description": "Moonshot AI's coding assistant",
          "distribution": { "binary": {
            "darwin-aarch64": { "archive": "https://example.com/kimi.tar.gz", "cmd": "./kimi", "args": ["acp"], "sha256": "43fe" },
            "linux-x86_64": { "archive": "https://example.com/kimi-linux.tar.gz", "cmd": "./kimi", "args": ["acp"] } } } },
        { "id": "both", "name": "Both", "version": "1.0.0",
          "distribution": { "npx": { "package": "both@1.0.0", "args": ["--acp"], "env": { "X": "1" } },
                            "binary": { "darwin-aarch64": { "archive": "https://example.com/b.zip", "cmd": "./b" } } } },
        { "id": "py", "name": "Py", "version": "2.0.0", "distribution": { "uvx": { "package": "py-agent==2.0.0", "args": ["serve"] } } }
      ],
      "extensions": []
    }"#;

    #[test]
    fn parses_the_registry_format() {
        let registry = parse(SAMPLE).unwrap();
        assert_eq!(registry.agents.len(), 4);
        let claude = &registry.agents[0];
        assert_eq!(claude.license_url.as_deref(), Some("https://example.com/LICENSE"));
        assert_eq!(claude.distribution.npx.as_ref().unwrap().package, "@agentclientprotocol/claude-agent-acp@0.90.0");
        let kimi = &registry.agents[1].distribution.binary.as_ref().unwrap()["darwin-aarch64"];
        assert_eq!(kimi.args, vec!["acp"]);
        assert_eq!(kimi.sha256.as_deref(), Some("43fe"));
        // Serialized for the frontend in camelCase.
        let json = serde_json::to_value(claude).unwrap();
        assert_eq!(json["licenseUrl"], "https://example.com/LICENSE");
        assert!(parse(r#"{"agents":[{"id":"../x","name":"x","version":"1","distribution":{}}]}"#).is_err());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn sables_own_entries_join_the_registry() {
        let extras = r#"{"agents":[{"id":"kimi-code","name":"Kimi Code","version":"2.2.0","distribution":{"npx":{"package":"@moonshot-ai/kimi-code@2.2.0","args":["acp"]}}},
                                   {"id":"claude-acp","name":"Old","version":"0.1.0","distribution":{}}]}"#;
        let merged = with_extras(parse(SAMPLE).unwrap(), extras);
        let kimi = merged.agents.iter().find(|a| a.id == "kimi-code").unwrap();
        assert_eq!(kimi.source.as_deref(), Some("sable"));
        assert_eq!(merged.agents.iter().filter(|a| a.id == "claude-acp").count(), 1);
        assert_eq!(merged.agents.iter().find(|a| a.id == "claude-acp").unwrap().version, "0.90.0");
        assert!(parse(EXTRA).is_ok());
        assert_eq!(merged.agents.iter().find(|a| a.id == "claude-code").unwrap().source.as_deref(), Some("cli"));
    }

    #[test]
    fn proprietary_downloads_need_consent() {
        let registry = parse(FALLBACK).unwrap();
        let by_id = |id: &str| registry.agents.iter().find(|agent| agent.id == id).unwrap();
        assert!(needs_consent(by_id("cursor")), "Cursor's CLI is proprietary and downloaded from Cursor");
        assert!(!needs_consent(by_id("claude-acp")), "an npm package the registry pins");
        assert!(!needs_consent(by_id("codex-acp")));
    }

    #[test]
    fn the_fallback_registry_parses() {
        let registry = parse(FALLBACK).unwrap();
        assert!(registry.agents.iter().any(|agent| agent.id == "claude-acp"));
    }

    #[test]
    fn picks_an_install_method_per_platform() {
        let registry = parse(SAMPLE).unwrap();
        let by_id = |id: &str| registry.agents.iter().find(|agent| agent.id == id).unwrap();
        assert_eq!(method(by_id("claude-acp"), Some("darwin-aarch64")).unwrap().kind(), "npx");
        assert_eq!(method(by_id("kimi"), Some("darwin-aarch64")).unwrap().kind(), "binary");
        // No build for Intel Macs, and nothing else to fall back on.
        let error = method(by_id("kimi"), Some("darwin-x86_64")).unwrap_err();
        assert!(error.contains("isn't available for darwin-x86_64"), "{error}");
        // A binary is preferred to Node where there's one.
        assert_eq!(method(by_id("both"), Some("darwin-aarch64")).unwrap().kind(), "binary");
        assert_eq!(method(by_id("both"), Some("linux-x86_64")).unwrap().kind(), "npx");
        assert_eq!(method(by_id("py"), None).unwrap().kind(), "uvx");
    }

    #[test]
    fn platform_names() {
        assert_eq!(platform_for("macos", "aarch64").as_deref(), Some("darwin-aarch64"));
        assert_eq!(platform_for("linux", "x86_64").as_deref(), Some("linux-x86_64"));
        assert_eq!(platform_for("windows", "aarch64").as_deref(), Some("windows-aarch64"));
        assert_eq!(platform_for("freebsd", "x86_64"), None);
        assert!(platform().is_some());
    }

    #[test]
    fn package_specs_and_versions() {
        assert_eq!(split_package("@agentclientprotocol/claude-agent-acp@0.90.0"), ("@agentclientprotocol/claude-agent-acp", Some("0.90.0")));
        assert_eq!(split_package("@scope/name"), ("@scope/name", None));
        assert_eq!(split_package("plain@1.2"), ("plain", Some("1.2")));
        assert_eq!(split_package("plain"), ("plain", None));
        assert!(is_newer("0.91.0", "0.90.0"));
        assert!(!is_newer("0.90.0", "0.90.0"));
        assert!(is_newer("1.9.0", "1.9.0-preview.2"));
        assert!(is_newer("2026.10.14", "2026.9.30"));
        assert!(!is_newer("1.52.0", "1.53.0"));
    }

    #[test]
    fn ids_are_folder_safe() {
        assert!(valid_id("claude-acp"));
        assert!(valid_id("codex_acp.2"));
        assert!(!valid_id(""));
        assert!(!valid_id(".."));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a\\b"));
    }
}
