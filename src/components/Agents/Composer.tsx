import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, FileCode2, FileText, Folder, Hash, ImagePlus, Shield, SlidersHorizontal, Sparkles, Square, X } from "lucide-react";
import { useAcpStore, type Mention, type PromptImage, type Thread } from "../../store/acpStore";
import type { SessionConfigOption, ConfigSelectGroup, ConfigSelectOption } from "../../lib/acp/protocol";
import { useTabsStore } from "../../store/tabsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore, workspaceRelativePath } from "../../store/workspaceStore";
import { useSetting } from "../../store/settingsStore";
import { getEditor } from "../../lib/editorRegistry";
import { listWorkspaceFiles } from "../../lib/ipc";
import { fuzzyScore } from "../../lib/fuzzy";
import { workspaceSymbols, type SymbolEntry } from "../../lib/lsp/navigation";
import { profileFor } from "../../lib/acp/agents";
import { Dropdown, type MenuOption } from "./Menu";

const baseName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

/** The file (and selection) in front, as a context chip. */
function useEditorContext(): Mention | null {
  const lastFilePath = useTabsStore((state) => state.lastFilePath);
  const activePath = useTabsStore((state) => state.activePath);
  useUiStore((state) => state.cursorPosition); // re-read the selection as it moves
  const enabled = useSetting("agents.includeActiveFile");
  if (!enabled || !lastFilePath || activePath !== lastFilePath) return null;
  const editor = getEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (model && selection && !selection.isEmpty()) {
    const text = model.getValueInRange(selection);
    if (text.trim()) {
      const start = selection.startLineNumber;
      const end = selection.endColumn === 1 && selection.endLineNumber > start ? selection.endLineNumber - 1 : selection.endLineNumber;
      return { kind: "selection", path: lastFilePath, label: `${baseName(lastFilePath)}:${start}${end !== start ? `-${end}` : ""}`, startLine: start, endLine: end, text };
    }
  }
  return { kind: "file", path: lastFilePath, label: baseName(lastFilePath) };
}

let fileCache: { root: string; files: string[]; at: number } | null = null;
async function workspaceFiles(): Promise<string[]> {
  const { folders, rootPath } = useWorkspaceStore.getState();
  if (!rootPath) return [];
  if (fileCache && fileCache.root === rootPath && Date.now() - fileCache.at < 15000) return fileCache.files;
  const lists = await Promise.all(folders.map((folder) => listWorkspaceFiles(folder).catch(() => [] as string[])));
  fileCache = { root: rootPath, files: lists.flat(), at: Date.now() };
  return fileCache.files;
}

interface Suggestion {
  key: string;
  kind: "file" | "folder" | "symbol" | "command";
  label: string;
  detail?: string;
  mention?: Mention;
  command?: { name: string; hint?: string };
}

function selectOptions(option: SessionConfigOption): MenuOption[] {
  if (option.type !== "select") return [];
  const out: MenuOption[] = [];
  const list = option.options as (ConfigSelectOption | ConfigSelectGroup)[];
  for (const entry of list) {
    if ("group" in entry) entry.options.forEach((choice, index) => out.push({ value: choice.value, label: choice.name, description: choice.description, group: index === 0 ? entry.name : undefined }));
    else out.push({ value: entry.value, label: entry.name, description: entry.description });
  }
  return out;
}

function optionLabel(option: SessionConfigOption): string {
  if (option.type === "boolean") return option.name;
  return selectOptions(option).find((choice) => choice.value === option.currentValue)?.label ?? String(option.currentValue);
}

const MODE_ICON = <Shield size={12} />;

export function Composer({ thread }: { thread: Thread }) {
  const send = useAcpStore((state) => state.send);
  const cancel = useAcpStore((state) => state.cancel);
  const setMode = useAcpStore((state) => state.setMode);
  const setConfigOption = useAcpStore((state) => state.setConfigOption);
  const request = useAcpStore((state) => state.composerRequest);
  const focusRequest = useUiStore((state) => state.agentFocusRequest);
  const promptCapabilities = useAcpStore((state) => state.connections[thread.agentId]?.init?.agentCapabilities?.promptCapabilities);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [images, setImages] = useState<PromptImage[]>([]);
  const [excluded, setExcluded] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorContext = useEditorContext();
  const contextKey = editorContext ? `${editorContext.path}:${editorContext.startLine ?? ""}-${editorContext.endLine ?? ""}` : null;
  const showContext = editorContext && excluded !== contextKey && !mentions.some((mention) => mention.path === editorContext.path && mention.kind === editorContext.kind);
  const running = thread.status === "running";
  const disabled = thread.readOnly || thread.status === "connecting" || thread.status === "loading" || !thread.cwd;
  const profile = profileFor(thread.agentId);

  // Drafts are per thread.
  const drafts = useRef(new Map<string, { text: string; mentions: Mention[]; images: PromptImage[] }>());
  const lastThread = useRef(thread.id);
  useEffect(() => {
    if (lastThread.current === thread.id) return;
    drafts.current.set(lastThread.current, { text, mentions, images });
    const draft = drafts.current.get(thread.id);
    setText(draft?.text ?? "");
    setMentions(draft?.mentions ?? []);
    setImages(draft?.images ?? []);
    lastThread.current = thread.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest, thread.id]);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [text]);

  const submit = (override?: { text: string; mentions: Mention[] }) => {
    const message = override?.text ?? text;
    const chosen = override?.mentions ?? mentions;
    if (running || disabled || (!message.trim() && !chosen.length && !images.length)) return;
    const all = [...chosen];
    if (!override && showContext && editorContext) all.unshift(editorContext);
    void send(thread.id, { text: message, mentions: all, images });
    setText("");
    setMentions([]);
    setImages([]);
    setSuggestions(null);
    setExcluded(null);
  };

  // "Send selection to agent", "Explain", "Fix": text from elsewhere.
  useEffect(() => {
    if (!request || request.threadId !== thread.id) return;
    useAcpStore.setState({ composerRequest: null });
    if (request.send && thread.status !== "connecting") submit({ text: request.text, mentions: request.mentions });
    else if (request.send) pendingSend.current = request;
    else {
      setText((current) => (current ? `${current} ${request.text}` : request.text));
      setMentions((current) => [...current, ...request.mentions.filter((mention) => !current.some((other) => other.path === mention.path && other.label === mention.label))]);
      requestAnimationFrame(() => input.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const pendingSend = useRef<typeof request>(null);
  useEffect(() => {
    if (pendingSend.current && thread.status === "idle") {
      const queued = pendingSend.current;
      pendingSend.current = null;
      submit({ text: queued.text, mentions: queued.mentions });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.status]);

  // @-mentions and / commands, from the text before the caret.
  const updateSuggestions = async (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const slash = /^\/([\w:.-]*)$/.exec(before);
    if (slash) {
      const query = slash[1];
      const items = thread.commands
        .map((command) => ({ command, score: query ? fuzzyScore(query, command.name) : 0 }))
        .filter((entry) => entry.score !== null)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 40)
        .map(({ command }): Suggestion => ({ key: `cmd:${command.name}`, kind: "command", label: `/${command.name}`, detail: command.description, command: { name: command.name, hint: command.input?.hint } }));
      setSuggestions(items);
      setActive(0);
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!at) {
      setSuggestions(null);
      return;
    }
    const query = at[2];
    const files = await workspaceFiles();
    const folders = new Set<string>();
    for (const file of files) {
      const parent = file.replace(/[/\\][^/\\]+$/, "");
      if (parent && parent !== file) folders.add(parent);
    }
    const root = useWorkspaceStore.getState().rootPath ?? "";
    const scored: (Suggestion & { score: number })[] = [];
    for (const file of files) {
      const relative = workspaceRelativePath(file);
      const score = query ? fuzzyScore(query, relative) : 1;
      if (score !== null) scored.push({ key: `f:${file}`, kind: "file", label: baseName(file), detail: relative.replace(/[^/\\]*$/, ""), mention: { kind: "file", path: file, label: baseName(file) }, score: score + (query && baseName(file).toLowerCase().startsWith(query.toLowerCase()) ? 20 : 0) });
    }
    for (const folder of folders) {
      if (folder === root) continue;
      const relative = workspaceRelativePath(folder);
      const score = query ? fuzzyScore(query, relative) : 0.5;
      if (score !== null) scored.push({ key: `d:${folder}`, kind: "folder", label: `${baseName(folder)}/`, detail: relative.replace(/[^/\\]*$/, ""), mention: { kind: "folder", path: folder, label: `${baseName(folder)}/` }, score: score - 1 });
    }
    scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
    const list: Suggestion[] = scored.slice(0, 30);
    setSuggestions(list);
    setActive(0);
    if (query.length >= 2) {
      const symbols: SymbolEntry[] = await workspaceSymbols(query, root).catch(() => []);
      if (symbols.length) {
        const current = input.current;
        if (!current || !/(^|\s)@([^\s@]*)$/.test(current.value.slice(0, current.selectionStart ?? 0))) return;
        setSuggestions([
          ...list.slice(0, 18),
          ...symbols.slice(0, 12).map((symbol): Suggestion => ({
            key: `s:${symbol.path}:${symbol.line}:${symbol.name}`,
            kind: "symbol",
            label: symbol.name,
            detail: `${baseName(symbol.path)}:${symbol.line}`,
            mention: { kind: "symbol", path: symbol.path, label: symbol.name, startLine: symbol.line, endLine: symbol.line },
          })),
        ]);
      }
    }
  };

  const pick = (suggestion: Suggestion | undefined) => {
    const element = input.current;
    if (!suggestion || !element) return;
    const caret = element.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    if (suggestion.kind === "command" && suggestion.command) {
      const next = `/${suggestion.command.name} ${after.trimStart()}`;
      setText(next);
      setSuggestions(null);
      requestAnimationFrame(() => {
        element.focus();
        const position = suggestion.command!.name.length + 2;
        element.setSelectionRange(position, position);
      });
      return;
    }
    const replaced = before.replace(/@([^\s@]*)$/, `@${suggestion.mention!.label} `);
    setText(replaced + after);
    setMentions((current) => (current.some((mention) => mention.path === suggestion.mention!.path && mention.label === suggestion.mention!.label) ? current : [...current, suggestion.mention!]));
    setSuggestions(null);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(replaced.length, replaced.length);
    });
  };

  const addImages = async (files: File[]) => {
    const wanted = files.filter((file) => file.type.startsWith("image/"));
    const read = await Promise.all(
      wanted.map(
        (file) =>
          new Promise<PromptImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ mimeType: file.type, data: String(reader.result).replace(/^data:[^,]*,/, ""), name: file.name || "pasted image" });
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }),
      ),
    );
    setImages((current) => [...current, ...read]);
  };

  // Pickers: mode, model, and the rest of the agent's options.
  const modeOption = thread.configOptions.find((option) => option.category === "mode" && option.type === "select");
  const modelOption = thread.configOptions.find((option) => option.category === "model" && option.type === "select");
  const others = thread.configOptions.filter((option) => option !== modeOption && option !== modelOption);
  const modeOptions: MenuOption[] = modeOption
    ? selectOptions(modeOption)
    : (thread.modes?.availableModes ?? []).map((mode) => ({ value: mode.id, label: mode.name, description: mode.description }));
  const currentMode = modeOption ? String(modeOption.currentValue) : (thread.modes?.currentModeId ?? null);
  const cycleMode = () => {
    if (!modeOptions.length) return;
    const index = modeOptions.findIndex((option) => option.value === currentMode);
    void setMode(thread.id, modeOptions[(index + 1) % modeOptions.length].value);
  };

  const contextUse = thread.context && thread.context.size > 0 ? thread.context.used / thread.context.size : null;
  const placeholder = thread.readOnly
    ? "This conversation is read-only (the agent can't reopen it)"
    : !thread.cwd
      ? "Open a folder first"
      : (profile?.placeholder ?? "Ask the agent…  @ to add context, / for commands");

  const chips = useMemo(() => mentions, [mentions]);

  return (
    <div
      className={`acp-composer${disabled ? " disabled" : ""}`}
      onDragOver={(event) => {
        if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        if (files.some((file) => file.type.startsWith("image/"))) {
          event.preventDefault();
          void addImages(files);
        }
      }}
    >
      {suggestions && suggestions.length > 0 && (
        <div className="acp-suggest" role="listbox">
          <div className="acp-suggest-heading">{suggestions[0].kind === "command" ? "Commands" : "Add context"}</div>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.key}
              role="option"
              aria-selected={index === active}
              className={index === active ? "acp-suggest-item active" : "acp-suggest-item"}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
            >
              {suggestion.kind === "file" ? <FileText size={13} /> : suggestion.kind === "folder" ? <Folder size={13} /> : suggestion.kind === "symbol" ? <Hash size={13} /> : <Sparkles size={13} />}
              <span className="acp-suggest-label">{suggestion.label}</span>
              {suggestion.detail && <span className="acp-suggest-detail">{suggestion.detail}</span>}
            </button>
          ))}
        </div>
      )}
      {(showContext || chips.length > 0 || images.length > 0) && (
        <div className="acp-chips">
          {showContext && editorContext && (
            <span className="acp-chip context" title={`${editorContext.kind === "selection" ? "The selection in" : "The file"} ${editorContext.path} — sent with your message`}>
              {editorContext.kind === "selection" ? <FileCode2 size={12} /> : <FileText size={12} />}
              <span>{editorContext.label}</span>
              <span className="acp-chip-note">{editorContext.kind === "selection" ? "selection" : "current file"}</span>
              <button title="Don't send it" onClick={() => setExcluded(contextKey)}>
                <X size={11} />
              </button>
            </span>
          )}
          {chips.map((mention, index) => (
            <span key={index} className="acp-chip" title={mention.path}>
              {mention.kind === "folder" ? <Folder size={12} /> : mention.kind === "symbol" ? <Hash size={12} /> : <FileText size={12} />}
              <span>{mention.label}</span>
              <button
                title="Remove"
                onClick={() => {
                  setMentions((current) => current.filter((_, other) => other !== index));
                  setText((current) => current.replace(`@${mention.label} `, "").replace(`@${mention.label}`, ""));
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {images.map((image, index) => (
            <span key={`img-${index}`} className="acp-chip image" title={image.name}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
              <button title="Remove" onClick={() => setImages((current) => current.filter((_, other) => other !== index))}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        className="acp-input"
        rows={2}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck
        onChange={(event) => {
          setText(event.target.value);
          void updateSuggestions(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
          if (files.length) {
            event.preventDefault();
            if (promptCapabilities?.image === false) return;
            void addImages(files);
          }
        }}
        onKeyDown={(event) => {
          if (suggestions && suggestions.length) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + step + suggestions.length) % suggestions.length);
              return;
            }
            if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
              event.preventDefault();
              pick(suggestions[active]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setSuggestions(null);
              return;
            }
          }
          if (event.key === "Tab" && event.shiftKey) {
            event.preventDefault();
            cycleMode();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape" && running) {
            event.preventDefault();
            cancel(thread.id);
          }
        }}
        onBlur={() => setTimeout(() => setSuggestions(null), 150)}
      />
      <div className="acp-composer-bar">
        <div className="acp-composer-pickers">
        {modeOptions.length > 0 && (
          <Dropdown
            testId="acp-mode"
            className={`acp-mode mode-${currentMode ?? ""}`}
            value={currentMode}
            options={modeOptions}
            icon={MODE_ICON}
            label={modeOptions.find((option) => option.value === currentMode)?.label ?? "Mode"}
            title="Mode (⇧Tab to cycle)"
            onChange={(value) => void setMode(thread.id, value)}
          />
        )}
        {modelOption && (
          <Dropdown
            testId="acp-model"
            value={String(modelOption.currentValue)}
            options={selectOptions(modelOption)}
            icon={<Sparkles size={12} />}
            label={optionLabel(modelOption)}
            title={modelOption.description ?? "Model"}
            onChange={(value) => void setConfigOption(thread.id, modelOption.id, value)}
          />
        )}
        {others.length > 0 && (
          <Dropdown
            testId="acp-options"
            className="secondary"
            value={null}
            options={others.flatMap((option): MenuOption[] =>
              option.type === "boolean"
                ? [
                    { value: `${option.id}\u0000on`, label: "On", group: option.name, checked: option.currentValue === true },
                    { value: `${option.id}\u0000off`, label: "Off", checked: option.currentValue === false },
                  ]
                : selectOptions(option).map((choice, index) => ({ ...choice, value: `${option.id}\u0000${choice.value}`, group: index === 0 ? option.name : choice.group, checked: choice.value === option.currentValue })),
            )}
            icon={<SlidersHorizontal size={12} />}
            label={(() => {
              const effort = others.find((option) => option.category === "thought_level");
              return effort ? optionLabel(effort) : `${others.length} option${others.length === 1 ? "" : "s"}`;
            })()}
            title={others.map((option) => `${option.name}: ${option.type === "boolean" ? (option.currentValue ? "on" : "off") : optionLabel(option)}`).join(" · ")}
            onChange={(choice) => {
              const [id, value] = choice.split("\u0000");
              const option = others.find((candidate) => candidate.id === id);
              if (!option) return;
              void setConfigOption(thread.id, id, option.type === "boolean" ? value === "on" : value);
            }}
          />
        )}
        </div>
        {contextUse !== null && (
          <span className={`acp-context${contextUse > 0.85 ? " high" : ""}`} title={`Context: ${Math.round(contextUse * 100)}% — ${thread.context!.used.toLocaleString()} of ${thread.context!.size.toLocaleString()} tokens${thread.context!.cost ? ` · ${thread.context!.cost.amount.toFixed(2)} ${thread.context!.cost.currency}` : ""}`}>
            <svg width={16} height={16} viewBox="0 0 16 16" aria-label={`${Math.round(contextUse * 100)}% of the context used`}>
              <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
              <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray={`${Math.max(0.5, contextUse * 37.7)} 37.7`} transform="rotate(-90 8 8)" />
            </svg>
          </span>
        )}
        <button className="acp-icon-button" title="Mention a file, folder or symbol (@)" disabled={disabled} onClick={() => {
          const element = input.current;
          if (!element) return;
          const next = `${text}${text && !text.endsWith(" ") ? " " : ""}@`;
          setText(next);
          element.focus();
          void updateSuggestions(next, next.length);
        }}>
          <AtSign size={14} />
        </button>
        {promptCapabilities?.image && (
          <>
            <button className="acp-icon-button" title="Attach an image (or paste one)" disabled={disabled} onClick={() => fileInput.current?.click()}>
              <ImagePlus size={14} />
            </button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(event) => void addImages([...(event.target.files ?? [])]).then(() => (event.target.value = ""))} />
          </>
        )}
        {running ? (
          <button className="acp-send stop" title="Stop (Esc)" onClick={() => cancel(thread.id)}>
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="acp-send" title="Send (⏎)" disabled={disabled || (!text.trim() && !mentions.length && !images.length)} onClick={() => submit()}>
            <ArrowUp size={14} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
