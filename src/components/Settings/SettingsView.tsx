import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, FileJson, KeyRound, RefreshCw, RotateCcw, Search } from "lucide-react";
import {
  MONO_FONT_STACK,
  SETTINGS_SCHEMA,
  useSettingsStore,
  type SettingKey,
  type SettingSpec,
} from "../../store/settingsStore";
import { useTabsStore } from "../../store/tabsStore";
import { useAgentStore } from "../../store/agentStore";
import { useUiStore } from "../../store/uiStore";
import {
  aiDeleteApiKey,
  aiListModels,
  aiSetApiKey,
  listMonospaceFonts,
  type AiProvider,
} from "../../lib/ipc";
import { BUNDLED_MONO_FAMILY } from "../../lib/fonts";
import { KEYBINDINGS } from "../../lib/useGlobalKeybindings";
import { pythonServerHasSemanticTokens } from "../../lib/ipc";
import { setUpPythonSemanticHighlighting } from "../../lib/lsp/lspClient";
import "./SettingsView.css";

const SECTIONS = [
  ...Array.from(new Set(SETTINGS_SCHEMA.map((spec) => spec.section))),
  "Keyboard Shortcuts",
];

const PROVIDERS: { id: AiProvider; label: string; keyHint: string; env: string }[] = [
  { id: "anthropic", label: "Anthropic", keyHint: "sk-ant-…", env: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", keyHint: "sk-…", env: "OPENAI_API_KEY" },
  { id: "google", label: "Google (Gemini)", keyHint: "AIza…", env: "GEMINI_API_KEY" },
];

/** The settings key holding each provider's model id. */
const MODEL_KEY: Record<AiProvider, SettingKey> = {
  anthropic: "ai.anthropicModel",
  openai: "ai.openaiModel",
  google: "ai.googleModel",
};

function matches(spec: SettingSpec, query: string): boolean {
  if (!query) return true;
  const haystack = `${spec.key} ${spec.label} ${spec.description} ${spec.section}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/**
 * The Settings page (a tab, ⌘,). Rendered entirely from SETTINGS_SCHEMA,
 * plus two hand-built blocks: API keys and the keyboard-shortcut list.
 */
export default function SettingsView() {
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState(SECTIONS[0]);
  const filePath = useSettingsStore((state) => state.filePath);

  const visibleSpecs = useMemo(
    () => SETTINGS_SCHEMA.filter((spec) => matches(spec, query)),
    [query],
  );
  const searching = query.trim() !== "";

  function scrollToSection(section: string) {
    setActiveSection(section);
    document
      .getElementById(`settings-section-${section}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="settings-view">
      <div className="settings-topbar">
        <div className="settings-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            autoFocus
            placeholder="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          className="settings-ghost-button"
          title={filePath ?? undefined}
          disabled={!filePath}
          onClick={() => filePath && void useTabsStore.getState().openFile(filePath)}
        >
          <FileJson size={14} strokeWidth={1.5} /> Open settings.json
        </button>
      </div>

      <div className="settings-body">
        {!searching && (
          <nav className="settings-nav">
            {SECTIONS.map((section) => (
              <button
                key={section}
                className={section === activeSection ? "active" : undefined}
                onClick={() => scrollToSection(section)}
              >
                {section}
              </button>
            ))}
          </nav>
        )}

        <div className="settings-content">
          {SECTIONS.map((section) => {
            if (section === "Keyboard Shortcuts") {
              if (searching && !"keyboard shortcuts keybindings".includes(query.toLowerCase())) {
                const hits = KEYBINDINGS.filter((binding) =>
                  binding.action.toLowerCase().includes(query.toLowerCase()),
                );
                if (hits.length === 0) return null;
                return <ShortcutsSection key={section} bindings={hits} />;
              }
              return <ShortcutsSection key={section} bindings={KEYBINDINGS} />;
            }
            const specs = visibleSpecs.filter((spec) => spec.section === section);
            const showKeys =
              section === "AI Agent" &&
              (!searching || /api|key|anthropic|openai|google|gemini/i.test(query));
            if (specs.length === 0 && !showKeys) return null;
            return (
              <section
                key={section}
                id={`settings-section-${section}`}
                className="settings-section"
              >
                <h2>{section}</h2>
                {section === "AI Agent" && (
                  <p className="settings-section-note">
                    The agent sends your messages and the files it reads to the
                    selected provider. Nothing is sent until you message it.
                  </p>
                )}
                {showKeys && <ApiKeysBlock />}
                {specs.map((spec) => (
                  <Fragment key={spec.key}>
                    <SettingRow spec={spec} />
                    {spec.key === "editor.semanticHighlighting" && <PythonSemanticSetup />}
                  </Fragment>
                ))}
              </section>
            );
          })}
          {searching &&
            visibleSpecs.length === 0 &&
            !KEYBINDINGS.some((binding) =>
              binding.action.toLowerCase().includes(query.toLowerCase()),
            ) && <div className="settings-empty">No settings match “{query}”.</div>}
        </div>
      </div>
    </div>
  );
}

function SettingRow({ spec }: { spec: SettingSpec }) {
  const value = useSettingsStore((state) => state.values[spec.key]);
  const set = useSettingsStore((state) => state.set);
  const reset = useSettingsStore((state) => state.reset);
  const modified = value !== spec.default;
  // Draft for text/number inputs so typing "1" on the way to "14" isn't
  // clamped mid-edit; committed on blur/Enter.
  const [draft, setDraft] = useState<string | null>(null);

  const modelProvider = (Object.keys(MODEL_KEY) as AiProvider[]).find(
    (provider) => MODEL_KEY[provider] === spec.key,
  );

  function commit(raw: string) {
    setDraft(null);
    if (spec.type === "number") {
      const parsed = Number(raw);
      if (raw.trim() !== "" && Number.isFinite(parsed)) set(spec.key, parsed as never);
    } else {
      set(spec.key, raw as never);
    }
  }

  let control: React.ReactNode;
  switch (spec.type) {
    case "boolean":
      control = (
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={value as boolean}
            onChange={(event) => set(spec.key, event.target.checked as never)}
          />
          <span className="settings-toggle-track" />
        </label>
      );
      break;
    case "enum":
      control = (
        <select
          className="settings-select"
          value={value as string}
          onChange={(event) => set(spec.key, event.target.value as never)}
        >
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
    case "number":
      control = (
        <input
          className="settings-input settings-number"
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
          }}
        />
      );
      break;
    case "string":
      control = spec.fontPicker ? (
        <FontPicker
          value={value as string}
          onChange={(stack) => set(spec.key, stack as never)}
        />
      ) : spec.multiline ? (
        <textarea
          className="settings-input settings-textarea"
          rows={4}
          placeholder={spec.placeholder}
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
        />
      ) : (
        <div className="settings-inline">
          <input
            className="settings-input"
            placeholder={spec.placeholder}
            list={modelProvider ? `models-${modelProvider}` : undefined}
            value={draft ?? String(value)}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(event.currentTarget.value);
            }}
          />
          {modelProvider && <ModelFetcher provider={modelProvider} />}
        </div>
      );
      break;
  }

  return (
    <div className={modified ? "settings-row modified" : "settings-row"}>
      <div className="settings-row-text">
        <div className="settings-row-label">
          {spec.label}
          <span className="settings-row-key">{spec.key}</span>
        </div>
        <div className="settings-row-description">{spec.description}</div>
      </div>
      <div className="settings-row-control">
        {control}
        <button
          className="settings-reset"
          title="Reset to default"
          style={{ visibility: modified ? "visible" : "hidden" }}
          onClick={() => {
            setDraft(null);
            reset(spec.key);
          }}
        >
          <RotateCcw size={12} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

/** Python needs basedpyright for semantic colors — offer to install it. */
function PythonSemanticSetup() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pythonServerHasSemanticTokens().then(setInstalled).catch(() => setInstalled(null));
  }, []);
  if (installed !== false) return null;
  return (
    <div className="settings-row settings-subrow">
      <div className="settings-row-text">
        <div className="settings-row-description">
          Python's semantic colors need basedpyright (Pyright with semantic
          highlighting). Sable installs it into its own folder — your global
          Pyright is untouched.
        </div>
      </div>
      <div className="settings-row-control">
        <button
          className="settings-ghost-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await setUpPythonSemanticHighlighting();
            setInstalled(await pythonServerHasSemanticTokens().catch(() => null));
            setBusy(false);
          }}
        >
          {busy ? "Installing…" : "Install basedpyright"}
        </button>
      </div>
    </div>
  );
}

/** Installed monospace fonts, fetched once per session. */
let monospaceFontsPromise: Promise<string[]> | null = null;

/** CSS generic that maps to SF Mono on macOS (not installable by name). */
const SYSTEM_MONO = "ui-monospace";

/** First family in a CSS font stack, without quotes. */
function firstFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

/** The font stack for a chosen family: it, then the bundled font. */
function stackFor(family: string): string {
  if (family.toLowerCase() === BUNDLED_MONO_FAMILY.toLowerCase()) return MONO_FONT_STACK;
  const head = family === SYSTEM_MONO ? family : `"${family}"`;
  return `${head}, "${BUNDLED_MONO_FAMILY}", monospace`;
}

/**
 * Dropdown of monospace fonts — the bundled JetBrains Mono, the system
 * mono (SF Mono), and every monospace font installed — with a live
 * preview in the chosen font.
 */
function FontPicker({ value, onChange }: { value: string; onChange: (stack: string) => void }) {
  const [installed, setInstalled] = useState<string[] | null>(null);
  const fontSize = useSettingsStore((state) => state.values["editor.fontSize"]);

  useEffect(() => {
    monospaceFontsPromise ??= listMonospaceFonts().catch(() => []);
    void monospaceFontsPromise.then(setInstalled);
  }, []);

  const options = [
    { value: BUNDLED_MONO_FAMILY, label: `${BUNDLED_MONO_FAMILY} (bundled)` },
    { value: SYSTEM_MONO, label: "SF Mono (system)" },
    ...(installed ?? [])
      .filter((family) => family.toLowerCase() !== BUNDLED_MONO_FAMILY.toLowerCase())
      .map((family) => ({ value: family, label: family })),
  ];
  const current = firstFamily(value);
  const selected =
    options.find((option) => option.value.toLowerCase() === current.toLowerCase())?.value ??
    current;
  // A saved font that isn't installed (anymore) stays visible and selected.
  if (!options.some((option) => option.value === selected)) {
    options.push({ value: selected, label: `${selected} (not installed)` });
  }

  return (
    <div className="settings-font-picker">
      <select
        className="settings-select"
        value={selected}
        onChange={(event) => onChange(stackFor(event.target.value))}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {installed === null && <option disabled>Loading installed fonts…</option>}
      </select>
      <div
        className="settings-font-preview"
        style={{ fontFamily: value, fontSize: Math.min(fontSize, 16) }}
      >
        {"def greet(name): return f\"Hi {name}\"  0O il1I {}[] => !="}
      </div>
    </div>
  );
}

/** "Fetch" button + datalist of the provider's live model ids. */
function ModelFetcher({ provider }: { provider: AiProvider }) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const baseUrl = useSettingsStore((state) => state.values["ai.openaiBaseUrl"]);

  async function fetchModels() {
    setLoading(true);
    try {
      const list = await aiListModels(provider, provider === "openai" ? baseUrl || null : null);
      setModels(list);
      if (list.length === 0) useUiStore.getState().setLastError("No models returned");
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        className="settings-ghost-button compact"
        title="Fetch the models your key can use"
        onClick={() => void fetchModels()}
        disabled={loading}
      >
        <RefreshCw size={12} strokeWidth={1.5} className={loading ? "spinning" : undefined} />
        {models.length > 0 ? `${models.length} models` : "Fetch"}
      </button>
      <datalist id={`models-${provider}`}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </>
  );
}

function ApiKeysBlock() {
  const keyStatus = useAgentStore((state) => state.keyStatus);
  const refreshKeyStatus = useAgentStore((state) => state.refreshKeyStatus);

  useEffect(() => {
    void refreshKeyStatus();
  }, [refreshKeyStatus]);

  return (
    <div className="settings-keys">
      <div className="settings-keys-title">
        <KeyRound size={13} strokeWidth={1.5} /> API Keys
        <span className="settings-row-description">
          Stored in your system keychain — never in settings.json.
        </span>
      </div>
      {PROVIDERS.map((provider) => (
        <ApiKeyRow
          key={provider.id}
          provider={provider}
          isSet={keyStatus?.[provider.id] ?? false}
          onChange={refreshKeyStatus}
        />
      ))}
    </div>
  );
}

function ApiKeyRow({
  provider,
  isSet,
  onChange,
}: {
  provider: (typeof PROVIDERS)[number];
  isSet: boolean;
  onChange: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await aiSetApiKey(provider.id, value);
      setValue("");
      await onChange();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await aiDeleteApiKey(provider.id);
      await onChange();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-key-row">
      <span className="settings-key-provider">{provider.label}</span>
      <span className={isSet ? "settings-key-status set" : "settings-key-status"}>
        {isSet ? (
          <>
            <Check size={12} strokeWidth={2} /> Set
          </>
        ) : (
          "Not set"
        )}
      </span>
      <input
        className="settings-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={isSet ? "Replace key…" : `${provider.keyHint}  (or set ${provider.env})`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
        }}
      />
      <button
        className="settings-ghost-button compact"
        disabled={busy || !value.trim()}
        onClick={() => void save()}
      >
        Save
      </button>
      <button
        className="settings-ghost-button compact danger"
        style={{ visibility: isSet ? "visible" : "hidden" }}
        disabled={busy}
        onClick={() => void remove()}
      >
        Remove
      </button>
    </div>
  );
}

function ShortcutsSection({
  bindings,
}: {
  bindings: { keys: string; action: string }[];
}) {
  return (
    <section id="settings-section-Keyboard Shortcuts" className="settings-section">
      <h2>Keyboard Shortcuts</h2>
      <div className="settings-shortcuts">
        {bindings.map((binding) => (
          <div key={binding.keys + binding.action} className="settings-shortcut">
            <span>{binding.action}</span>
            <kbd>{binding.keys}</kbd>
          </div>
        ))}
      </div>
    </section>
  );
}
