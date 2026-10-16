//! How each agent can sign in or reach a model provider, and what makes it
//! do so: its environment, flags, and (Codex) a config file of Sable's own.
//! One table, here, drives both the Settings → AI Agents forms (the
//! frontend reads it) and how the agent starts — so adding a provider (or
//! an agent) is adding an entry to `providers()`.
//!
//! Values the user types are kept in agents/config.json, except secret
//! ones (API keys, AWS keys, tokens), which live in the OS keychain and
//! are only put into the agent's environment when it starts. Config files
//! Sable writes for an agent never contain secrets: they name the
//! variables the secrets arrive in.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldOption {
    pub value: String,
    pub label: String,
    /// More settings in the agent's config file when this is chosen.
    #[serde(skip)]
    pub config: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub label: String,
    /// The variable it sets (none: a choice that shows other fields).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    pub secret: bool,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<FieldOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// Only applies when another field has one of these values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<(String, Vec<String>)>,
    /// A dotted key in the config file Sable writes for the agent (`{field}`
    /// stands for another field's value).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    /// A flag the value is passed with when the agent starts (`--model`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arg: Option<String>,
    /// A flag the value is passed with to the agent's sign-in (`--region`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_arg: Option<String>,
}

/// Commands (arguments in place of the agent's ACP ones) for an account
/// the agent itself keeps: check, sign in (in a terminal), sign out.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountCommands {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<Vec<String>>,
    /// How `status` answers: "json" (its output), or "exit" (exit code 0
    /// means signed in; it prints a line saying how).
    pub status_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<Vec<String>>,
    /// Signing in with a one-time code (no browser on this machine needed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_device: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logout: Option<Vec<String>>,
    /// Sign out through the agent's own ACP `logout` (no CLI command for it).
    pub logout_acp: bool,
}

/// A folder of Sable's own for the agent's settings (Sable's data folder,
/// `.data/<agent>/<dir>`), with a config file Sable writes, and the
/// variable that points the agent at it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHome {
    pub env: String,
    pub dir: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthProvider {
    pub id: String,
    pub label: String,
    pub description: String,
    /// "subscription", "account", "apiKey", "cloud", "local", "custom", "cli".
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help_url: Option<String>,
    pub fields: Vec<Field>,
    /// Set whenever this provider is chosen.
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountCommands>,
    /// The agent's own ACP auth methods that sign in this way.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub acp_methods: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<ConfigHome>,
    /// Fixed settings in that config file (dotted keys).
    #[serde(skip)]
    pub config: Vec<(String, String)>,
}

/// What the user chose for one agent (agents/config.json). No secrets.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default)]
    pub provider: Option<String>,
    /// Non-secret field values, by `<provider>.<field>` (each method keeps
    /// its own: Bedrock's model isn't Vertex's).
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    /// Extra environment variables of the user's own.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentsConfig {
    #[serde(default)]
    pub agents: BTreeMap<String, AgentConfig>,
}

/// Claude Agent (claude-agent-acp) always runs with `--hide-claude-auth`:
/// Anthropic doesn't permit third-party apps to offer claude.ai login or to
/// route requests through Free/Pro/Max plan credentials
/// (https://code.claude.com/docs/en/legal-and-compliance), so the adapter
/// hides that login and refuses any turn a subscription would pay for.
/// Sable offers API billing and cloud providers only.
pub const CLAUDE_AGENT_ARGS: &[&str] = &["--hide-claude-auth"];

/// Stands for the agent's data folder in environment values (resolved
/// where the agent runs: this machine or the remote).
pub const AGENT_DATA: &str = "${SABLE_AGENT_DATA}";

/// A file to write into the agent's data folder before it starts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFile {
    /// Relative to the agent's data folder.
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BuiltEnv {
    /// Arguments added after the agent's own.
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// Inherited variables that would steer the agent elsewhere.
    pub unset: Vec<String>,
    pub provider: String,
    /// Files the agent reads (its config), written before it starts.
    pub files: Vec<AgentFile>,
    /// Arguments added to the agent's sign-in commands.
    pub login_args: Vec<String>,
}

/// (value, label, config settings it adds).
type OptionWithConfig<'a> = (&'a str, &'a str, &'a [(&'a str, &'a str)]);

struct FieldBuilder(Field);

impl FieldBuilder {
    fn new(key: &str, label: &str, env: Option<&str>) -> Self {
        FieldBuilder(Field {
            key: key.into(),
            label: label.into(),
            env: env.map(Into::into),
            secret: false,
            required: false,
            placeholder: None,
            help: None,
            options: Vec::new(),
            default: None,
            when: None,
            config: None,
            arg: None,
            login_arg: None,
        })
    }
    fn secret(mut self) -> Self {
        self.0.secret = true;
        self
    }
    fn required(mut self) -> Self {
        self.0.required = true;
        self
    }
    fn placeholder(mut self, text: &str) -> Self {
        self.0.placeholder = Some(text.into());
        self
    }
    fn help(mut self, text: &str) -> Self {
        self.0.help = Some(text.into());
        self
    }
    fn default(mut self, value: &str) -> Self {
        self.0.default = Some(value.into());
        self
    }
    fn options(mut self, options: &[(&str, &str)]) -> Self {
        self.0.options = options.iter().map(|(value, label)| FieldOption { value: (*value).into(), label: (*label).into(), config: vec![] }).collect();
        self
    }
    /// Options that also put settings in the config file.
    fn options_with_config(mut self, options: &[OptionWithConfig]) -> Self {
        self.0.options = options
            .iter()
            .map(|(value, label, config)| FieldOption { value: (*value).into(), label: (*label).into(), config: config.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect() })
            .collect();
        self
    }
    fn when(mut self, key: &str, values: &[&str]) -> Self {
        self.0.when = Some((key.into(), values.iter().map(|v| (*v).into()).collect()));
        self
    }
    fn config(mut self, key: &str) -> Self {
        self.0.config = Some(key.into());
        self
    }
    fn arg(mut self, flag: &str) -> Self {
        self.0.arg = Some(flag.into());
        self
    }
    fn login_arg(mut self, flag: &str) -> Self {
        self.0.login_arg = Some(flag.into());
        self
    }
}

fn field(key: &str, label: &str, env: Option<&str>) -> FieldBuilder {
    FieldBuilder::new(key, label, env)
}

fn provider(id: &str, label: &str, description: &str, help_url: Option<&str>, env: &[(&str, &str)], fields: Vec<FieldBuilder>) -> AuthProvider {
    AuthProvider {
        id: id.into(),
        label: label.into(),
        description: description.into(),
        kind: "custom".into(),
        help_url: help_url.map(Into::into),
        fields: fields.into_iter().map(|f| f.0).collect(),
        env: env.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
        account: None,
        acp_methods: vec![],
        home: None,
        config: vec![],
    }
}

impl AuthProvider {
    fn kind(mut self, kind: &str) -> Self {
        self.kind = kind.into();
        self
    }
    fn acp(mut self, methods: &[&str]) -> Self {
        self.acp_methods = methods.iter().map(|m| (*m).into()).collect();
        self
    }
    fn account(mut self, account: AccountCommands) -> Self {
        self.account = Some(account);
        self
    }
    /// Settings in a config file of Sable's own (`home`).
    fn home(mut self, home: &ConfigHome, settings: &[(&str, &str)]) -> Self {
        self.home = Some(home.clone());
        self.config = settings.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
        self
    }
}

fn args(list: &[&str]) -> Option<Vec<String>> {
    Some(list.iter().map(|arg| (*arg).into()).collect())
}

fn model_field(placeholder: &str) -> FieldBuilder {
    field("model", "Model", Some("ANTHROPIC_MODEL")).placeholder(placeholder).help("Optional. Leave empty to pick a model in the panel.")
}

/// The ways `agent_id` can authenticate, the default first.
pub fn providers(agent_id: &str) -> Vec<AuthProvider> {
    match agent_id {
        "claude-acp" => claude_agent(),
        "claude-code" => {
            let cli = provider(
                "cli",
                "Your Claude Code sign-in",
                "Runs your installed claude CLI exactly as it is, with its own sign-in (a Claude subscription, Console account, or whatever you've set up in Claude Code). Sable passes no credentials and never reads them; to sign in, Sable opens a terminal running claude where you type /login.",
                Some("https://code.claude.com/docs/en/authentication"),
                &[],
                vec![field("path", "claude location", Some("SABLE_CLAUDE_PATH")).placeholder("Found automatically").help("Optional: the claude executable to run, if it isn't found.")],
            )
            .kind("cli")
            .account(AccountCommands {
                status: args(&["--cli", "auth", "status", "--json"]),
                status_format: "json".into(),
                login: args(&["--cli"]),
                logout: args(&["--cli", "auth", "logout"]),
                ..Default::default()
            });
            vec![cli]
        }
        "codex-acp" => codex(),
        "kimi-code" => kimi_code(),
        "cursor" => cursor(),
        // Any other agent: whatever it offers itself.
        _ => vec![provider(
            "default",
            "The agent's own sign-in",
            "The agent signs in its own way; Sable offers its sign-in methods in the panel when it asks.",
            None,
            &[],
            vec![],
        )
        .kind("account")],
    }
}

fn claude_agent() -> Vec<AuthProvider> {
    let console = provider(
        "console",
        "Anthropic Console account",
        "Sign in with an Anthropic Console account (console.anthropic.com): usage is billed to that account's API credits. Signing in opens a terminal; Claude Agent keeps the credential in your keychain.",
        Some("https://code.claude.com/docs/en/authentication"),
        &[],
        vec![],
    )
    .kind("account")
    .acp(&["console-login"])
    .account(AccountCommands {
        status: args(&["--cli", "auth", "status", "--json"]),
        status_format: "json".into(),
        login: args(&["--cli", "auth", "login", "--console"]),
        logout: args(&["--cli", "auth", "logout"]),
        ..Default::default()
    });
    vec![
        console,
        provider(
            "apiKey",
            "Anthropic API key",
            "Pay per token with a key from the Claude Console (console.anthropic.com).",
            Some("https://console.anthropic.com/settings/keys"),
            &[],
            vec![field("apiKey", "API key", Some("ANTHROPIC_API_KEY")).secret().required().placeholder("sk-ant-…"), model_field("e.g. claude-sonnet-5")],
        )
        .kind("apiKey"),
        provider(
            "bedrock",
            "Amazon Bedrock",
            "Run Claude through your AWS account. Uses your AWS credentials: the default chain (environment, ~/.aws, SSO), a named profile, access keys, or a Bedrock API key.",
            Some("https://code.claude.com/docs/en/amazon-bedrock"),
            &[("CLAUDE_CODE_USE_BEDROCK", "1")],
            {
                let mut fields = vec![field("region", "AWS region", Some("AWS_REGION")).placeholder("us-east-1").help("Optional if your AWS profile sets a region.")];
                fields.extend(aws_credentials());
                fields.extend([
                    field("model", "Model or inference profile", Some("ANTHROPIC_MODEL"))
                        .placeholder("us.anthropic.claude-sonnet-4-6 or an ARN")
                        .help("Optional: pins the model (an inference profile ID or application inference profile ARN)."),
                    field("smallModel", "Small/fast model", Some("ANTHROPIC_DEFAULT_HAIKU_MODEL")).placeholder("us.anthropic.claude-haiku-4-5-20251001-v1:0").help("Optional: for background tasks."),
                    field("baseUrl", "Bedrock endpoint URL", Some("ANTHROPIC_BEDROCK_BASE_URL")).placeholder("https://bedrock-runtime.us-east-1.amazonaws.com").help("Optional: a custom endpoint or gateway."),
                ]);
                fields
            },
        )
        .kind("cloud"),
        provider(
            "vertex",
            "Google Vertex AI",
            "Run Claude through Google Cloud (Agent Platform). Uses Application Default Credentials (`gcloud auth application-default login`) or a service account key file.",
            Some("https://code.claude.com/docs/en/google-vertex-ai"),
            &[("CLAUDE_CODE_USE_VERTEX", "1")],
            vec![
                field("projectId", "GCP project ID", Some("ANTHROPIC_VERTEX_PROJECT_ID")).required().placeholder("my-project"),
                field("region", "Region", Some("CLOUD_ML_REGION")).default("global").placeholder("global, us-east5, eu…"),
                field("credentialsFile", "Credentials file", Some("GOOGLE_APPLICATION_CREDENTIALS")).placeholder("/path/to/key.json").help("Optional: a service account key or credential configuration file."),
                model_field("e.g. claude-sonnet-5"),
            ],
        )
        .kind("cloud"),
        provider(
            "foundry",
            "Microsoft Foundry",
            "Run Claude through Azure (Microsoft Foundry). Uses an API key, or your Microsoft Entra ID sign-in (`az login`) when no key is given.",
            Some("https://code.claude.com/docs/en/microsoft-foundry"),
            &[("CLAUDE_CODE_USE_FOUNDRY", "1")],
            vec![
                field("resource", "Resource name", Some("ANTHROPIC_FOUNDRY_RESOURCE")).required().placeholder("my-resource").help("The resource's name only, not its URL."),
                field("apiKey", "API key", Some("ANTHROPIC_FOUNDRY_API_KEY")).secret().help("Optional: without one, Entra ID (az login) is used."),
                field("model", "Deployment", Some("ANTHROPIC_MODEL")).placeholder("claude-sonnet-5").help("Optional: the deployment name to use."),
            ],
        )
        .kind("cloud"),
        provider(
            "gateway",
            "Custom gateway",
            "Send requests through an LLM gateway or proxy that speaks the Anthropic API (LiteLLM, your company's gateway…).",
            Some("https://code.claude.com/docs/en/llm-gateway"),
            &[],
            vec![
                field("baseUrl", "Base URL", Some("ANTHROPIC_BASE_URL")).required().placeholder("https://gateway.example.com"),
                field("authToken", "Auth token", Some("ANTHROPIC_AUTH_TOKEN")).secret().help("Sent as a Bearer token. Optional if the gateway doesn't need one."),
                field("headers", "Custom headers", Some("ANTHROPIC_CUSTOM_HEADERS")).placeholder("X-Team: platform").help("Optional: one `Name: value` per line."),
                model_field("e.g. claude-sonnet-5"),
            ],
        )
        .kind("custom"),
    ]
}

/// The AWS credential choice and its fields (the AWS SDK's own variables).
fn aws_credentials() -> Vec<FieldBuilder> {
    vec![
        field("credentials", "Credentials", None)
            .options(&[("default", "AWS default credentials"), ("profile", "Named AWS profile"), ("keys", "Access key and secret"), ("apiKey", "Bedrock API key")])
            .default("default"),
        field("profile", "AWS profile", Some("AWS_PROFILE")).required().placeholder("default").when("credentials", &["profile"]).help("From ~/.aws/config. For SSO, run `aws sso login --profile <name>` first."),
        field("accessKeyId", "Access key ID", Some("AWS_ACCESS_KEY_ID")).secret().required().placeholder("AKIA…").when("credentials", &["keys"]),
        field("secretAccessKey", "Secret access key", Some("AWS_SECRET_ACCESS_KEY")).secret().required().when("credentials", &["keys"]),
        field("sessionToken", "Session token", Some("AWS_SESSION_TOKEN")).secret().when("credentials", &["keys"]).help("Only for temporary credentials."),
        field("bearerToken", "Bedrock API key", Some("AWS_BEARER_TOKEN_BEDROCK")).secret().required().when("credentials", &["apiKey"]),
    ]
}

/// Codex (codex-acp, which drives the Codex CLI's app-server).
///
/// - ChatGPT: the user's own ~/.codex, so the sign-in is shared with the
///   Codex CLI and IDE extensions; the panel signs in in-band (ACP
///   `authenticate`: the adapter opens the browser, or asks Sable to open
///   a device-code page — URL elicitation).
/// - Everything else runs Codex with a `CODEX_HOME` of Sable's own, whose
///   config.toml Sable writes: Codex decides whether a sign-in is needed
///   from that file's `model_provider` (codex-acp's `CODEX_CONFIG` only
///   reaches threads, so a provider set there still asks for a ChatGPT
///   login), and the API key method keeps its login in memory only
///   (`cli_auth_credentials_store = "ephemeral"`), so the key is never
///   written to disk and the user's ChatGPT login is left alone.
fn codex() -> Vec<AuthProvider> {
    let home = ConfigHome { env: "CODEX_HOME".into(), dir: "codex-home".into(), file: "config.toml".into() };
    let ephemeral = ("cli_auth_credentials_store", "ephemeral");
    let model = |placeholder: &str| field("model", "Model", None).config("model").placeholder(placeholder).help("Optional: the model new threads start with (you can switch in the panel).");
    vec![
        provider(
            "chatgpt",
            "ChatGPT account",
            "Use your ChatGPT plan (Plus, Pro, Business, Edu or Enterprise) — no API billing. You sign in in your browser, or with a one-time code on another device; Codex keeps the sign-in in ~/.codex, shared with the Codex CLI and its IDE extensions.",
            Some("https://learn.chatgpt.com/docs/auth"),
            &[],
            vec![],
        )
        .kind("subscription")
        .acp(&["chat-gpt", "chat-gpt-device-code"])
        .account(AccountCommands {
            status: args(&["cli", "login", "status"]),
            status_format: "exit".into(),
            login: args(&["cli", "login"]),
            login_device: args(&["cli", "login", "--device-auth"]),
            logout: args(&["cli", "logout"]),
            logout_acp: false,
        }),
        provider(
            "apiKey",
            "OpenAI API key",
            "Pay per token with a key from platform.openai.com. Sable passes the key to Codex when it starts and Codex holds it in memory only — it isn't written to ~/.codex, and your ChatGPT sign-in there is untouched.",
            Some("https://platform.openai.com/api-keys"),
            &[("DEFAULT_AUTH_REQUEST", r#"{"methodId":"api-key"}"#)],
            vec![
                field("apiKey", "API key", Some("CODEX_API_KEY")).secret().required().placeholder("sk-…"),
                model("e.g. gpt-6.1-sol"),
                field("baseUrl", "API base URL", None)
                    .config("openai_base_url")
                    .placeholder("https://api.openai.com/v1")
                    .help("Optional: a proxy or data-residency endpoint for the OpenAI API (it must support the Responses API)."),
            ],
        )
        .kind("apiKey")
        .acp(&["api-key"])
        .home(&home, &[ephemeral]),
        provider(
            "bedrock",
            "Amazon Bedrock",
            "Run OpenAI models (gpt-oss, GPT-5.x/6.x) through your AWS account — no ChatGPT sign-in or OpenAI key. Uses your AWS credentials: the default chain (environment, ~/.aws, SSO), a named profile, access keys, or a Bedrock API key.",
            Some("https://learn.chatgpt.com/docs/amazon-bedrock"),
            &[],
            {
                let mut fields = vec![
                    field("endpoint", "Endpoint", None)
                        .config("model_provider")
                        .options_with_config(&[
                            ("amazon-bedrock-runtime", "Bedrock Runtime (cross-Region inference)", &[("web_search", "disabled")]),
                            ("amazon-bedrock", "Bedrock Mantle (in-Region, with hosted web search)", &[("web_search", "cached")]),
                        ])
                        .default("amazon-bedrock-runtime"),
                    field("region", "AWS region", Some("AWS_REGION")).required().config("model_providers.{endpoint}.aws.region").placeholder("us-east-2").help("Where the model is available to your account."),
                ];
                let mut credentials = aws_credentials();
                // The profile goes in Codex's own provider settings too.
                credentials[1].0.config = Some("model_providers.{endpoint}.aws.profile".into());
                fields.extend(credentials);
                fields.push(model("e.g. global.openai.gpt-6.1-sol"));
                fields
            },
        )
        .kind("cloud")
        .home(&home, &[ephemeral]),
        provider(
            "azure",
            "Azure OpenAI",
            "Use a deployment in your Azure OpenAI (Microsoft Foundry) resource, with its API key.",
            Some("https://learn.chatgpt.com/docs/config-file/config-advanced"),
            &[],
            vec![
                field("baseUrl", "Endpoint", None)
                    .required()
                    .config("model_providers.azure.base_url")
                    .placeholder("https://YOUR-RESOURCE.openai.azure.com/openai")
                    .help("Your resource's endpoint, ending in /openai."),
                field("apiKey", "API key", Some("AZURE_OPENAI_API_KEY")).secret().required(),
                field("model", "Deployment", None).required().config("model").placeholder("gpt-6.1-sol").help("The deployment's name."),
                field("apiVersion", "API version", None).config("model_providers.azure.query_params.api-version").default("2025-04-01-preview"),
            ],
        )
        .kind("cloud")
        .home(
            &home,
            &[
                ephemeral,
                ("model_provider", "azure"),
                ("model_providers.azure.name", "Azure OpenAI"),
                ("model_providers.azure.env_key", "AZURE_OPENAI_API_KEY"),
                ("model_providers.azure.wire_api", "responses"),
            ],
        ),
        provider(
            "local",
            "Local model (Ollama, LM Studio)",
            "Run an open-weight model on this machine with Ollama or LM Studio — nothing leaves your computer and no sign-in is needed. Start the server and pull the model first.",
            Some("https://learn.chatgpt.com/docs/config-file/config-advanced"),
            &[],
            vec![
                field("server", "Server", None).config("model_provider").options(&[("ollama", "Ollama"), ("lmstudio", "LM Studio")]).default("ollama"),
                field("model", "Model", None).required().config("model").placeholder("gpt-oss:20b").help("A model you've pulled (`ollama pull gpt-oss:20b`)."),
                field("baseUrl", "Server URL", Some("CODEX_OSS_BASE_URL")).placeholder("http://localhost:11434/v1").help("Optional: if the server isn't on its usual port."),
            ],
        )
        .kind("local")
        .home(&home, &[ephemeral]),
        provider(
            "custom",
            "OpenAI-compatible endpoint",
            "Any provider or gateway that serves the OpenAI Responses API (OpenRouter, LiteLLM, vLLM, your company's gateway…).",
            Some("https://learn.chatgpt.com/docs/config-file/config-advanced"),
            &[],
            vec![
                field("baseUrl", "Base URL", None).required().config("model_providers.sable-endpoint.base_url").placeholder("https://openrouter.ai/api/v1"),
                field("apiKey", "API key", Some("SABLE_CODEX_ENDPOINT_KEY")).secret().required().help("Sent as a Bearer token (any value if your server doesn't check one)."),
                field("model", "Model", None).required().config("model").placeholder("openai/gpt-oss-120b"),
                field("name", "Name", None).config("model_providers.sable-endpoint.name").default("Custom endpoint").help("Shown in Codex's status."),
            ],
        )
        .kind("custom")
        .home(
            &home,
            &[
                ephemeral,
                ("model_provider", "sable-endpoint"),
                ("model_providers.sable-endpoint.env_key", "SABLE_CODEX_ENDPOINT_KEY"),
                ("model_providers.sable-endpoint.wire_api", "responses"),
            ],
        ),
    ]
}

/// Kimi Code (Moonshot AI's Kimi Code CLI, `kimi acp`).
///
/// - Kimi account: its own device-code sign-in, run in a terminal
///   (`kimi acp --login`, the ACP terminal auth method), kept in
///   ~/.kimi-code and shared with the kimi CLI.
/// - API keys and other providers: Kimi Code's `KIMI_MODEL_*` variables,
///   which define a model (and its provider) in memory for that process
///   and make it the default — nothing is written to ~/.kimi-code.
fn kimi_code() -> Vec<AuthProvider> {
    let model = |placeholder: &str, help: &str| field("model", "Model", Some("KIMI_MODEL_NAME")).required().placeholder(placeholder).help(help);
    let context = || field("contextSize", "Context window (tokens)", Some("KIMI_MODEL_MAX_CONTEXT_SIZE")).placeholder("262144").help("Optional: the model's context size.");
    vec![
        provider(
            "account",
            "Kimi account",
            "Use your Kimi Code plan. Signing in opens a terminal running Kimi Code's own sign-in (a one-time code you confirm in your browser); Kimi Code keeps it in ~/.kimi-code, shared with the kimi CLI.",
            Some("https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html"),
            &[],
            vec![field("region", "Account region", None)
                .login_arg("--region")
                .options(&[("", "Automatic"), ("global", "International (kimi.ai)"), ("mainland-cn", "Mainland China (kimi.com)")])
                .default("")
                .help("Where your Kimi account is. Automatic uses mainland China unless you've signed in to kimi.ai before.")],
        )
        .kind("subscription")
        .acp(&["login"])
        .account(AccountCommands { login: args(&["acp", "--login"]), status_format: "json".into(), logout_acp: true, ..Default::default() }),
        provider(
            "platform",
            "Kimi Platform API key",
            "Pay per token with a Moonshot AI open-platform key (platform.kimi.ai or platform.kimi.com).",
            Some("https://platform.kimi.ai/console/api-keys"),
            &[("KIMI_MODEL_PROVIDER_TYPE", "kimi")],
            vec![
                field("endpoint", "Platform", Some("KIMI_MODEL_BASE_URL"))
                    .options(&[("https://api.moonshot.ai/v1", "platform.kimi.ai (international)"), ("https://api.moonshot.cn/v1", "platform.kimi.com (mainland China)")])
                    .default("https://api.moonshot.ai/v1"),
                field("apiKey", "API key", Some("KIMI_MODEL_API_KEY")).secret().required().placeholder("sk-…"),
                model("kimi-k2-turbo-preview", "A model id from the platform's model list."),
                context(),
            ],
        )
        .kind("apiKey"),
        provider(
            "anthropic",
            "Anthropic API key",
            "Run Kimi Code with Claude models, paid per token with a key from console.anthropic.com.",
            Some("https://console.anthropic.com/settings/keys"),
            &[("KIMI_MODEL_PROVIDER_TYPE", "anthropic")],
            vec![
                field("apiKey", "API key", Some("KIMI_MODEL_API_KEY")).secret().required().placeholder("sk-ant-…"),
                model("claude-sonnet-5", "An Anthropic model id."),
                field("baseUrl", "Base URL", Some("KIMI_MODEL_BASE_URL")).placeholder("https://api.anthropic.com").help("Optional: a proxy or gateway."),
                context(),
            ],
        )
        .kind("apiKey"),
        provider(
            "openai",
            "OpenAI or compatible API",
            "OpenAI, or any service with an OpenAI-compatible API (OpenRouter, Together, DeepSeek, your gateway…), with its API key.",
            Some("https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html"),
            &[],
            vec![
                field("api", "API", Some("KIMI_MODEL_PROVIDER_TYPE")).options(&[("openai", "Chat Completions"), ("openai_responses", "Responses")]).default("openai"),
                field("baseUrl", "Base URL", Some("KIMI_MODEL_BASE_URL")).placeholder("https://api.openai.com/v1").help("Optional for OpenAI itself."),
                field("apiKey", "API key", Some("KIMI_MODEL_API_KEY")).secret().required().placeholder("sk-…"),
                model("gpt-6.1-sol", "The model id the service expects."),
                context(),
            ],
        )
        .kind("apiKey"),
        provider(
            "gemini",
            "Google Gemini API key",
            "Run Kimi Code with Gemini models, with a key from Google AI Studio.",
            Some("https://aistudio.google.com/apikey"),
            &[("KIMI_MODEL_PROVIDER_TYPE", "google-genai")],
            vec![field("apiKey", "API key", Some("KIMI_MODEL_API_KEY")).secret().required(), model("gemini-3-pro", "A Gemini model id."), context()],
        )
        .kind("apiKey"),
        provider(
            "local",
            "Local model (Ollama, LM Studio, vLLM)",
            "A model served on this machine (or your network) through an OpenAI-compatible API — no account needed.",
            Some("https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html"),
            // Kimi Code wants a key for the default model; local servers ignore it.
            &[("KIMI_MODEL_PROVIDER_TYPE", "openai"), ("KIMI_MODEL_API_KEY", "local")],
            vec![
                field("baseUrl", "Server URL", Some("KIMI_MODEL_BASE_URL")).required().default("http://localhost:11434/v1").placeholder("http://localhost:11434/v1").help("Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1"),
                model("qwen3-coder:30b", "A model the server has (`ollama pull …`)."),
                field("apiKey", "API key", Some("KIMI_MODEL_API_KEY")).secret().help("Optional: only if your server checks one."),
                context(),
            ],
        )
        .kind("local"),
    ]
}

/// Cursor (`cursor-agent acp`, Cursor's proprietary CLI). Requests always
/// go through Cursor's service: a Cursor account (its own browser sign-in,
/// kept in Cursor's own credential store) or a Cursor API key.
fn cursor() -> Vec<AuthProvider> {
    let model = || {
        field("model", "Model", None)
            .arg("--model")
            .placeholder("e.g. gpt-6.1-sol, sonnet-5-thinking")
            .help("Optional: starts Cursor with this model (`--model`), for when switching in the panel doesn't stick. `cursor-agent models` lists yours.")
    };
    vec![
        provider(
            "account",
            "Cursor account",
            "Use your Cursor plan. Sign in in your browser — from the panel, or here (a terminal running `cursor-agent login`). Cursor keeps the sign-in in its own store (the macOS Keychain, or ~/.config/cursor), shared with the Cursor CLI.",
            Some("https://cursor.com/docs/cli/reference/authentication"),
            &[],
            vec![model()],
        )
        .kind("subscription")
        .acp(&["cursor_login"])
        .account(AccountCommands {
            status: args(&["status", "--format", "json"]),
            status_format: "json".into(),
            login: args(&["login"]),
            logout: args(&["logout"]),
            ..Default::default()
        }),
        provider(
            "apiKey",
            "Cursor API key",
            "A key from the Cursor dashboard (Integrations → API keys), billed to your Cursor plan — for machines where you can't sign in in a browser.",
            Some("https://cursor.com/dashboard?tab=integrations"),
            &[],
            vec![field("apiKey", "API key", Some("CURSOR_API_KEY")).secret().required().placeholder("key_…"), model()],
        )
        .kind("apiKey"),
    ]
}

/// Where a field's value is kept: `<provider>.<field>` (the keychain
/// entry for a secret one, the key in config.json otherwise).
pub fn value_key(provider: &str, field: &str) -> String {
    format!("{provider}.{field}")
}

fn plain_value(provider: &str, key: &str, values: &BTreeMap<String, String>, fields: &[Field]) -> String {
    values.get(&value_key(provider, key)).cloned().or_else(|| fields.iter().find(|f| f.key == key).and_then(|f| f.default.clone())).unwrap_or_default()
}

fn active(provider: &str, field: &Field, values: &BTreeMap<String, String>, fields: &[Field]) -> bool {
    let Some((key, allowed)) = &field.when else { return true };
    allowed.contains(&plain_value(provider, key, values, fields))
}

/// The fields of `provider` that apply with these values.
pub fn active_fields<'a>(provider: &'a AuthProvider, values: &BTreeMap<String, String>) -> Vec<&'a Field> {
    provider.fields.iter().filter(|field| active(&provider.id, field, values, &provider.fields)).collect()
}

/// `{name}` in a config key → that field's value.
fn expand(key: &str, provider: &AuthProvider, values: &BTreeMap<String, String>) -> String {
    let mut out = key.to_string();
    for field in &provider.fields {
        let token = format!("{{{}}}", field.key);
        if out.contains(&token) {
            out = out.replace(&token, &plain_value(&provider.id, &field.key, values, &provider.fields));
        }
    }
    out
}

/// The environment for `agent_id` with `config`; `secret(key)` reads a
/// secret field from the keychain.
pub fn build(agent_id: &str, config: &AgentConfig, secret: &dyn Fn(&str) -> Option<String>) -> Result<BuiltEnv, String> {
    let all = providers(agent_id);
    let chosen = match &config.provider {
        Some(id) => all.iter().find(|p| &p.id == id).ok_or_else(|| format!("Unknown sign-in method {id:?}"))?,
        None => &all[0],
    };
    let mut env = chosen.env.clone();
    let mut args: Vec<String> = if agent_id == "claude-acp" { CLAUDE_AGENT_ARGS.iter().map(|arg| arg.to_string()).collect() } else { vec![] };
    let mut login_args = Vec::new();
    let mut settings: Vec<(String, String)> = chosen.config.clone();
    for field in active_fields(chosen, &config.values) {
        let key = value_key(&chosen.id, &field.key);
        let value = if field.secret { secret(&key) } else { config.values.get(&key).cloned().or_else(|| field.default.clone()) };
        let value = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let Some(value) = value else {
            if field.required {
                return Err(format!("{}: {} is missing. Add it in Settings → AI Agents.", chosen.label, field.label));
            }
            continue;
        };
        if let Some(variable) = &field.env {
            let value = if variable == "ANTHROPIC_CUSTOM_HEADERS" { value.replace("\r\n", "\n") } else { value.clone() };
            env.insert(variable.clone(), value);
        }
        if let Some(key) = &field.config {
            settings.push((expand(key, chosen, &config.values), value.clone()));
        }
        if let Some(option) = field.options.iter().find(|option| option.value == value) {
            settings.extend(option.config.iter().map(|(k, v)| (expand(k, chosen, &config.values), v.clone())));
        }
        if let Some(flag) = &field.arg {
            args.extend([flag.clone(), value.clone()]);
        }
        if let Some(flag) = &field.login_arg {
            login_args.extend([flag.clone(), value.clone()]);
        }
    }
    if agent_id == "kimi-code" {
        if let Some(name) = env.get("KIMI_MODEL_NAME").cloned() {
            env.entry("KIMI_MODEL_DISPLAY_NAME".into()).or_insert(name);
        }
    }
    let mut files = Vec::new();
    if let Some(home) = &chosen.home {
        env.insert(home.env.clone(), format!("{AGENT_DATA}/{}", home.dir));
        files.push(AgentFile { path: format!("{}/{}", home.dir, home.file), contents: toml(&settings) });
    }
    // Whatever another method would set must not leak in from the
    // environment Sable was started with (an exported API key would
    // otherwise win over the Console login, say). A config folder variable
    // (CODEX_HOME) is the user's own choice when no method sets it.
    let mine: BTreeSet<&String> = env.keys().collect();
    let homes: BTreeSet<&String> = all.iter().filter_map(|p| p.home.as_ref().map(|h| &h.env)).collect();
    let mut unset: BTreeSet<String> = BTreeSet::new();
    for other in &all {
        for variable in other.env.keys().chain(other.fields.iter().filter_map(|f| f.env.as_ref())) {
            if !mine.contains(variable) && !homes.contains(variable) && steers(agent_id, variable) {
                unset.insert(variable.clone());
            }
        }
    }
    if agent_id == "kimi-code" && !mine.contains(&"KIMI_MODEL_DISPLAY_NAME".to_string()) {
        unset.insert("KIMI_MODEL_DISPLAY_NAME".into());
    }
    for (name, value) in &config.env {
        if !name.trim().is_empty() {
            unset.remove(name);
            env.insert(name.trim().to_string(), value.clone());
        }
    }
    Ok(BuiltEnv { args, env, unset: unset.into_iter().collect(), provider: chosen.id.clone(), files, login_args })
}

/// A status command's output → `{loggedIn, email?, detail?, …}` (None:
/// it said nothing Sable understands).
pub fn account_status_of(format: &str, code: Option<i64>, stdout: &str, stderr: &str) -> Option<Value> {
    if format == "exit" {
        // Codex: "Logged in using ChatGPT" / "Not logged in", exit 0 / 1.
        let line = stdout.lines().chain(stderr.lines()).map(str::trim).find(|line| !line.is_empty()).unwrap_or("").to_string();
        let code = code?;
        let how = line.strip_prefix("Logged in using ").map(|how| how.trim_start_matches("an ").trim_start_matches("a ").to_string());
        return Some(json!({ "loggedIn": code == 0, "detail": line, "authMethod": how }));
    }
    let mut parsed = stdout.find('{').and_then(|start| serde_json::from_str::<Value>(&stdout[start..]).ok())?;
    // Cursor: {status, isAuthenticated, userInfo: {email}, message}.
    if parsed.get("loggedIn").is_none() {
        if let Some(authenticated) = parsed.get("isAuthenticated").and_then(Value::as_bool) {
            let email = parsed["userInfo"]["email"].clone();
            let detail = parsed["message"].clone();
            let object = parsed.as_object_mut()?;
            object.insert("loggedIn".into(), json!(authenticated));
            if email.is_string() {
                object.insert("email".into(), email);
            }
            if detail.is_string() {
                object.insert("detail".into(), detail);
            }
        }
    }
    Some(parsed)
}

/// Whether an inherited `variable` would change how `agent_id` signs in
/// (and so is removed when the chosen method doesn't set it). Codex picks
/// its provider from config.toml, not the environment: AWS or Azure
/// variables only matter to a provider that names them — perhaps the
/// user's own, in ~/.codex — so they're left alone; an API key isn't.
fn steers(agent_id: &str, variable: &str) -> bool {
    match agent_id {
        "codex-acp" => matches!(variable, "CODEX_API_KEY" | "DEFAULT_AUTH_REQUEST"),
        _ => true,
    }
}

/// Dotted keys and string values as TOML (later keys win; tables nest).
pub fn toml(settings: &[(String, String)]) -> String {
    #[derive(Default)]
    struct Table {
        values: BTreeMap<String, String>,
        tables: BTreeMap<String, Table>,
    }
    fn key_text(key: &str) -> String {
        if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            key.to_string()
        } else {
            serde_json::to_string(key).unwrap_or_default()
        }
    }
    fn write(table: &Table, path: &[String], out: &mut String) {
        if !table.values.is_empty() && !path.is_empty() {
            out.push_str(&format!("\n[{}]\n", path.iter().map(|part| key_text(part)).collect::<Vec<_>>().join(".")));
        }
        for (key, value) in &table.values {
            out.push_str(&format!("{} = {}\n", key_text(key), serde_json::to_string(value).unwrap_or_default()));
        }
        for (key, child) in &table.tables {
            let mut child_path = path.to_vec();
            child_path.push(key.clone());
            write(child, &child_path, out);
        }
    }
    let mut root = Table::default();
    for (key, value) in settings {
        let parts: Vec<&str> = key.split('.').filter(|part| !part.is_empty()).collect();
        let Some((last, parents)) = parts.split_last() else { continue };
        let mut table = &mut root;
        for part in parents {
            table.values.remove(*part);
            table = table.tables.entry((*part).to_string()).or_default();
        }
        table.tables.remove(*last);
        table.values.insert((*last).to_string(), value.clone());
    }
    let mut out = String::from("# Written by Sable for this sign-in method (Settings → AI Agents); it's rewritten whenever the agent starts.\n");
    write(&root, &[], &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str, values: &[(&str, &str)]) -> AgentConfig {
        AgentConfig { provider: Some(provider.into()), values: values.iter().map(|(k, v)| (value_key(provider, k), (*v).into())).collect(), env: BTreeMap::new() }
    }

    fn secrets(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    #[test]
    fn the_console_login_is_the_default_and_clears_other_credentials() {
        let built = build("claude-acp", &AgentConfig::default(), &secrets(&[])).unwrap();
        assert_eq!(built.provider, "console");
        // Never a claude.ai subscription (Anthropic's terms for third-party apps).
        assert_eq!(built.args, vec!["--hide-claude-auth"]);
        assert!(!providers("claude-acp").iter().any(|p| p.id == "subscription"));
        assert!(built.env.is_empty());
        for variable in ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK"] {
            assert!(built.unset.contains(&variable.to_string()), "{variable} should be unset");
        }
        let claude = &providers("claude-acp")[0];
        assert_eq!(claude.account.as_ref().unwrap().status.as_ref().unwrap(), &vec!["--cli", "auth", "status", "--json"]);
        assert_eq!(claude.account.as_ref().unwrap().login.as_ref().unwrap(), &vec!["--cli", "auth", "login", "--console"]);
        // Every method runs hidden from claude.ai login.
        let keyed = build("claude-acp", &config("apiKey", &[]), &secrets(&[("apiKey.apiKey", "k")])).unwrap();
        assert_eq!(keyed.args, vec!["--hide-claude-auth"]);
    }

    #[test]
    fn an_api_key_comes_from_the_keychain() {
        let built = build("claude-acp", &config("apiKey", &[("model", "claude-sonnet-5")]), &secrets(&[("apiKey.apiKey", "sk-ant-test")])).unwrap();
        assert_eq!(built.env["ANTHROPIC_API_KEY"], "sk-ant-test");
        assert_eq!(built.env["ANTHROPIC_MODEL"], "claude-sonnet-5");
        assert!(!built.unset.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert!(built.unset.contains(&"CLAUDE_CODE_USE_BEDROCK".to_string()));
        let missing = build("claude-acp", &config("apiKey", &[]), &secrets(&[])).unwrap_err();
        assert!(missing.contains("API key is missing"), "{missing}");
    }

    #[test]
    fn bedrock_with_each_kind_of_credentials() {
        let default = build("claude-acp", &config("bedrock", &[("region", "eu-west-1")]), &secrets(&[])).unwrap();
        assert_eq!(default.env["CLAUDE_CODE_USE_BEDROCK"], "1");
        assert_eq!(default.env["AWS_REGION"], "eu-west-1");
        assert!(!default.env.contains_key("AWS_PROFILE"));

        let profile = build("claude-acp", &config("bedrock", &[("credentials", "profile"), ("profile", "work"), ("model", "us.anthropic.claude-sonnet-4-6")]), &secrets(&[])).unwrap();
        assert_eq!(profile.env["AWS_PROFILE"], "work");
        assert_eq!(profile.env["ANTHROPIC_MODEL"], "us.anthropic.claude-sonnet-4-6");
        // A profile's name is required once you pick it.
        assert!(build("claude-acp", &config("bedrock", &[("credentials", "profile")]), &secrets(&[])).is_err());

        let keys = build(
            "claude-acp",
            &config("bedrock", &[("credentials", "keys")]),
            &secrets(&[("bedrock.accessKeyId", "AKIA1"), ("bedrock.secretAccessKey", "s3cret"), ("bedrock.sessionToken", "tok")]),
        )
        .unwrap();
        assert_eq!(keys.env["AWS_ACCESS_KEY_ID"], "AKIA1");
        assert_eq!(keys.env["AWS_SECRET_ACCESS_KEY"], "s3cret");
        assert_eq!(keys.env["AWS_SESSION_TOKEN"], "tok");
        assert!(!keys.env.contains_key("AWS_BEARER_TOKEN_BEDROCK"));

        // Keys stored for another credential kind don't leak in.
        let bearer = build("claude-acp", &config("bedrock", &[("credentials", "apiKey")]), &secrets(&[("bedrock.bearerToken", "bed"), ("bedrock.accessKeyId", "AKIA1")])).unwrap();
        assert_eq!(bearer.env["AWS_BEARER_TOKEN_BEDROCK"], "bed");
        assert!(!bearer.env.contains_key("AWS_ACCESS_KEY_ID"));
        assert!(bearer.unset.contains(&"AWS_ACCESS_KEY_ID".to_string()));
    }

    #[test]
    fn vertex_foundry_and_gateways() {
        let vertex = build("claude-acp", &config("vertex", &[("projectId", "proj")]), &secrets(&[])).unwrap();
        assert_eq!(vertex.env["CLAUDE_CODE_USE_VERTEX"], "1");
        assert_eq!(vertex.env["ANTHROPIC_VERTEX_PROJECT_ID"], "proj");
        assert_eq!(vertex.env["CLOUD_ML_REGION"], "global", "the default region");
        assert!(build("claude-acp", &config("vertex", &[]), &secrets(&[])).is_err());

        let foundry = build("claude-acp", &config("foundry", &[("resource", "res")]), &secrets(&[])).unwrap();
        assert_eq!(foundry.env["CLAUDE_CODE_USE_FOUNDRY"], "1");
        assert_eq!(foundry.env["ANTHROPIC_FOUNDRY_RESOURCE"], "res");
        assert!(!foundry.env.contains_key("ANTHROPIC_FOUNDRY_API_KEY"), "Entra ID without a key");

        let gateway = build("claude-acp", &config("gateway", &[("baseUrl", "https://gw.example.com"), ("headers", "A: 1\r\nB: 2")]), &secrets(&[("gateway.authToken", "tok")])).unwrap();
        assert_eq!(gateway.env["ANTHROPIC_BASE_URL"], "https://gw.example.com");
        assert_eq!(gateway.env["ANTHROPIC_AUTH_TOKEN"], "tok");
        assert_eq!(gateway.env["ANTHROPIC_CUSTOM_HEADERS"], "A: 1\nB: 2");
        assert!(gateway.unset.contains(&"ANTHROPIC_API_KEY".to_string()));
    }

    #[test]
    fn user_variables_win_and_other_agents_get_a_default() {
        let mut with_env = config("console", &[]);
        with_env.env.insert("ANTHROPIC_BASE_URL".into(), "http://proxy".into());
        with_env.env.insert("DISABLE_TELEMETRY".into(), "1".into());
        let built = build("claude-acp", &with_env, &secrets(&[])).unwrap();
        assert_eq!(built.env["ANTHROPIC_BASE_URL"], "http://proxy");
        assert!(!built.unset.contains(&"ANTHROPIC_BASE_URL".to_string()));
        assert_eq!(built.env["DISABLE_TELEMETRY"], "1");

        // Claude Code: nothing about credentials goes in or out.
        let cli = build("claude-code", &AgentConfig::default(), &secrets(&[])).unwrap();
        assert!(cli.env.is_empty() && cli.args.is_empty() && cli.unset.iter().all(|name| name == "SABLE_CLAUDE_PATH"), "{cli:?}");
        let overridden = build("claude-code", &config("cli", &[("path", "/opt/claude")]), &secrets(&[])).unwrap();
        assert_eq!(overridden.env["SABLE_CLAUDE_PATH"], "/opt/claude");

        let other = build("opencode", &AgentConfig::default(), &secrets(&[])).unwrap();
        assert_eq!(other.provider, "default");
        assert!(other.env.is_empty() && other.unset.is_empty() && other.files.is_empty());
        assert!(build("claude-acp", &config("nope", &[]), &secrets(&[])).is_err());
    }

    #[test]
    fn account_status_formats() {
        // Codex prints on stderr and answers with its exit code.
        let codex = account_status_of("exit", Some(0), "", "Logged in using ChatGPT\n").unwrap();
        assert_eq!(codex["loggedIn"], true);
        assert_eq!(codex["authMethod"], "ChatGPT");
        let out = account_status_of("exit", Some(1), "", "Not logged in\n").unwrap();
        assert_eq!(out["loggedIn"], false);
        assert_eq!(out["detail"], "Not logged in");
        // Cursor's status --format json.
        let cursor = account_status_of("json", Some(0), r#"{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"a@b.c"}}"#, "").unwrap();
        assert_eq!(cursor["loggedIn"], true);
        assert_eq!(cursor["email"], "a@b.c");
        let signed_out = account_status_of("json", Some(0), r#"{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}"#, "").unwrap();
        assert_eq!(signed_out["loggedIn"], false);
        // Claude's own JSON passes through.
        let claude = account_status_of("json", Some(0), "noise {\"loggedIn\":true,\"authMethod\":\"console\"}", "").unwrap();
        assert_eq!(claude["authMethod"], "console");
        assert!(account_status_of("json", Some(1), "garbage", "").is_none());
    }

    #[test]
    fn toml_nests_dotted_keys() {
        let text = toml(&[
            ("model_provider".into(), "amazon-bedrock".into()),
            ("model_providers.amazon-bedrock.aws.region".into(), "us-east-2".into()),
            ("model_providers.amazon-bedrock.aws.profile".into(), "work \"x\"".into()),
            ("model_providers.azure.query_params.api-version".into(), "2025-04-01-preview".into()),
            ("model".into(), "first".into()),
            ("model".into(), "second".into()),
        ]);
        assert!(text.starts_with("# Written by Sable"));
        assert!(text.contains("model = \"second\"\nmodel_provider = \"amazon-bedrock\"\n"), "{text}");
        assert!(text.contains("\n[model_providers.amazon-bedrock.aws]\nprofile = \"work \\\"x\\\"\"\nregion = \"us-east-2\"\n"), "{text}");
        assert!(text.contains("\n[model_providers.azure.query_params]\napi-version = \"2025-04-01-preview\"\n"), "{text}");
        assert!(!text.contains("first"));
    }

    fn file(built: &BuiltEnv) -> &str {
        &built.files.iter().find(|file| file.path == "codex-home/config.toml").expect("a Codex config file").contents
    }

    #[test]
    fn codex_chatgpt_uses_the_users_own_codex_folder() {
        let built = build("codex-acp", &AgentConfig::default(), &secrets(&[])).unwrap();
        assert_eq!(built.provider, "chatgpt");
        assert!(built.files.is_empty() && !built.env.contains_key("CODEX_HOME"), "{built:?}");
        assert!(!built.unset.contains(&"CODEX_HOME".to_string()), "a CODEX_HOME of the user's own is kept");
        for variable in ["CODEX_API_KEY", "DEFAULT_AUTH_REQUEST"] {
            assert!(built.unset.contains(&variable.to_string()), "{variable}");
        }
        // A provider of the user's own in ~/.codex may need these.
        for variable in ["AWS_PROFILE", "AWS_REGION", "AZURE_OPENAI_API_KEY", "CODEX_OSS_BASE_URL"] {
            assert!(!built.unset.contains(&variable.to_string()), "{variable} is left alone");
        }
        let chatgpt = &providers("codex-acp")[0];
        assert_eq!(chatgpt.kind, "subscription");
        assert_eq!(chatgpt.acp_methods, vec!["chat-gpt", "chat-gpt-device-code"]);
        let account = chatgpt.account.as_ref().unwrap();
        assert_eq!(account.status_format, "exit");
        assert_eq!(account.login_device.as_ref().unwrap(), &vec!["cli", "login", "--device-auth"]);
    }

    #[test]
    fn codex_api_key_stays_in_memory() {
        let built = build("codex-acp", &config("apiKey", &[("model", "gpt-6.1-sol")]), &secrets(&[("apiKey.apiKey", "sk-test")])).unwrap();
        assert_eq!(built.env["CODEX_API_KEY"], "sk-test");
        assert_eq!(built.env["DEFAULT_AUTH_REQUEST"], r#"{"methodId":"api-key"}"#);
        assert_eq!(built.env["CODEX_HOME"], "${SABLE_AGENT_DATA}/codex-home");
        let toml = file(&built);
        assert!(toml.contains("cli_auth_credentials_store = \"ephemeral\"") && toml.contains("model = \"gpt-6.1-sol\""), "{toml}");
        assert!(!toml.contains("sk-test"), "no secret in the file");
        assert!(build("codex-acp", &config("apiKey", &[]), &secrets(&[])).unwrap_err().contains("API key is missing"));
    }

    #[test]
    fn codex_bedrock_writes_the_provider_settings() {
        let built = build(
            "codex-acp",
            &config("bedrock", &[("region", "us-east-2"), ("credentials", "profile"), ("profile", "work"), ("model", "global.openai.gpt-6.1-sol")]),
            &secrets(&[]),
        )
        .unwrap();
        let toml = file(&built);
        assert!(toml.contains("model_provider = \"amazon-bedrock-runtime\"") && toml.contains("web_search = \"disabled\""), "{toml}");
        assert!(toml.contains("[model_providers.amazon-bedrock-runtime.aws]\nprofile = \"work\"\nregion = \"us-east-2\""), "{toml}");
        assert_eq!(built.env["AWS_REGION"], "us-east-2");
        assert_eq!(built.env["AWS_PROFILE"], "work");
        // Mantle, with a Bedrock API key.
        let mantle = build("codex-acp", &config("bedrock", &[("endpoint", "amazon-bedrock"), ("region", "us-west-2"), ("credentials", "apiKey")]), &secrets(&[("bedrock.bearerToken", "bedrock-key")])).unwrap();
        let toml = file(&mantle);
        assert!(toml.contains("model_provider = \"amazon-bedrock\"") && toml.contains("web_search = \"cached\"") && toml.contains("[model_providers.amazon-bedrock.aws]\nregion = \"us-west-2\""), "{toml}");
        assert_eq!(mantle.env["AWS_BEARER_TOKEN_BEDROCK"], "bedrock-key");
        assert!(!toml.contains("bedrock-key"));
        assert!(mantle.unset.contains(&"CODEX_API_KEY".to_string()), "an exported OpenAI key doesn't sign Codex in");
        // A region is needed.
        assert!(build("codex-acp", &config("bedrock", &[]), &secrets(&[])).is_err());
    }

    #[test]
    fn codex_azure_local_and_custom_endpoints() {
        let azure = build("codex-acp", &config("azure", &[("baseUrl", "https://r.openai.azure.com/openai"), ("model", "my-deploy")]), &secrets(&[("azure.apiKey", "az")])).unwrap();
        let toml = file(&azure);
        assert!(toml.contains("model_provider = \"azure\"") && toml.contains("env_key = \"AZURE_OPENAI_API_KEY\"") && toml.contains("wire_api = \"responses\""), "{toml}");
        assert!(toml.contains("[model_providers.azure.query_params]\napi-version = \"2025-04-01-preview\""), "{toml}");
        assert_eq!(azure.env["AZURE_OPENAI_API_KEY"], "az");

        let local = build("codex-acp", &config("local", &[("server", "lmstudio"), ("model", "qwen3")]), &secrets(&[])).unwrap();
        let toml = file(&local);
        assert!(toml.contains("model_provider = \"lmstudio\"") && toml.contains("model = \"qwen3\""), "{toml}");
        assert!(local.env.keys().all(|k| k == "CODEX_HOME"), "no credentials for a local server: {:?}", local.env);

        let custom = build("codex-acp", &config("custom", &[("baseUrl", "https://gw.example.com/v1"), ("model", "m")]), &secrets(&[("custom.apiKey", "k")])).unwrap();
        let toml = file(&custom);
        assert!(toml.contains("model_provider = \"sable-endpoint\"") && toml.contains("base_url = \"https://gw.example.com/v1\"") && toml.contains("name = \"Custom endpoint\""), "{toml}");
        assert_eq!(custom.env["SABLE_CODEX_ENDPOINT_KEY"], "k");
    }

    #[test]
    fn kimi_account_and_keys_through_its_model_variables() {
        let account = build("kimi-code", &AgentConfig::default(), &secrets(&[])).unwrap();
        assert_eq!(account.provider, "account");
        assert!(account.env.is_empty() && account.files.is_empty() && account.login_args.is_empty());
        for variable in ["KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_PROVIDER_TYPE", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_DISPLAY_NAME"] {
            assert!(account.unset.contains(&variable.to_string()), "{variable}");
        }
        let global = build("kimi-code", &config("account", &[("region", "global")]), &secrets(&[])).unwrap();
        assert_eq!(global.login_args, vec!["--region", "global"]);
        let kimi = &providers("kimi-code")[0];
        assert_eq!(kimi.account.as_ref().unwrap().login.as_ref().unwrap(), &vec!["acp", "--login"]);
        assert!(kimi.account.as_ref().unwrap().logout_acp);

        let platform = build("kimi-code", &config("platform", &[("model", "kimi-k2-turbo-preview")]), &secrets(&[("platform.apiKey", "sk-moon")])).unwrap();
        assert_eq!(platform.env["KIMI_MODEL_PROVIDER_TYPE"], "kimi");
        assert_eq!(platform.env["KIMI_MODEL_BASE_URL"], "https://api.moonshot.ai/v1");
        assert_eq!(platform.env["KIMI_MODEL_API_KEY"], "sk-moon");
        assert_eq!(platform.env["KIMI_MODEL_NAME"], "kimi-k2-turbo-preview");
        assert_eq!(platform.env["KIMI_MODEL_DISPLAY_NAME"], "kimi-k2-turbo-preview");
        assert!(platform.files.is_empty(), "nothing is written to ~/.kimi-code");
        assert!(build("kimi-code", &config("platform", &[("model", "x")]), &secrets(&[])).is_err(), "the key is needed");

        let local = build("kimi-code", &config("local", &[("model", "qwen3-coder:30b")]), &secrets(&[])).unwrap();
        assert_eq!(local.env["KIMI_MODEL_BASE_URL"], "http://localhost:11434/v1");
        assert_eq!(local.env["KIMI_MODEL_API_KEY"], "local", "a placeholder key for servers that don't check");
        let keyed = build("kimi-code", &config("local", &[("model", "m")]), &secrets(&[("local.apiKey", "real")])).unwrap();
        assert_eq!(keyed.env["KIMI_MODEL_API_KEY"], "real");
        let anthropic = build("kimi-code", &config("anthropic", &[("model", "claude-sonnet-5")]), &secrets(&[("anthropic.apiKey", "sk-ant")])).unwrap();
        assert_eq!(anthropic.env["KIMI_MODEL_PROVIDER_TYPE"], "anthropic");
        let responses = build("kimi-code", &config("openai", &[("api", "openai_responses"), ("model", "m")]), &secrets(&[("openai.apiKey", "k")])).unwrap();
        assert_eq!(responses.env["KIMI_MODEL_PROVIDER_TYPE"], "openai_responses");
    }

    #[test]
    fn cursor_account_api_key_and_model_flag() {
        let account = build("cursor", &AgentConfig::default(), &secrets(&[])).unwrap();
        assert_eq!(account.provider, "account");
        assert!(account.env.is_empty() && account.args.is_empty());
        assert!(account.unset.contains(&"CURSOR_API_KEY".to_string()), "an exported key doesn't take over the account");
        let cursor = &providers("cursor")[0];
        assert_eq!(cursor.account.as_ref().unwrap().status.as_ref().unwrap(), &vec!["status", "--format", "json"]);
        assert_eq!(cursor.acp_methods, vec!["cursor_login"]);

        let keyed = build("cursor", &config("apiKey", &[("model", "sonnet-5")]), &secrets(&[("apiKey.apiKey", "key_x")])).unwrap();
        assert_eq!(keyed.env["CURSOR_API_KEY"], "key_x");
        assert_eq!(keyed.args, vec!["--model", "sonnet-5"]);
        assert!(build("cursor", &config("apiKey", &[]), &secrets(&[])).is_err());
    }

    #[test]
    fn every_method_is_described_and_secrets_never_go_in_files() {
        for agent in ["claude-acp", "claude-code", "codex-acp", "kimi-code", "cursor"] {
            for provider in providers(agent) {
                assert!(!provider.label.is_empty() && !provider.description.is_empty() && !provider.kind.is_empty(), "{agent}/{}", provider.id);
                for field in &provider.fields {
                    assert!(!(field.secret && field.config.is_some()), "{agent}/{}.{}: a secret must not go in a file", provider.id, field.key);
                    assert!(!(field.secret && (field.arg.is_some() || field.login_arg.is_some())), "secrets never go on a command line");
                }
            }
        }
    }
}
