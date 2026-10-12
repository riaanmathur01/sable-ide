import { create } from "zustand";
import { useTabsStore } from "../store/tabsStore";
import { useUiStore } from "../store/uiStore";
import { useDebugStore } from "../store/debugStore";
import { useBreakpointsStore } from "../store/breakpointsStore";
import { useTerminalStore } from "../store/terminalStore";
import { DEFAULT_SETTINGS, useSettingsStore } from "../store/settingsStore";
import { useNavigationStore } from "../store/navigationStore";
import { useTestStore } from "../store/testStore";
import { getEditor } from "./editorRegistry";
import { runActiveFile } from "./runFile";
import { openFolderDialog } from "./openFolder";
import { addFolderToWorkspace, closeWindow, newWindow } from "./workspaceCommands";
import { refactor, refactorThis } from "./refactor";
import { readFile, writeFile } from "./ipc";
import { formatKey, isMac, matchesKey, parseKey, type ParsedKey } from "./plugins/keybindings";
import { onPluginEvent } from "./plugins/events";
import { vimOwnsKey } from "./vim";
import { paletteRunner } from "./paletteRunner";
import { parseJsonc } from "./jsonc";
import { broadcast } from "./windows";

/**
 * Keyboard shortcuts: Sable's commands with their default keys, and your
 * overrides in keybindings.json (next to settings.json) — VS Code's
 * format, so a VS Code keybindings.json mostly carries over:
 *
 *   [
 *     { "key": "cmd+shift+k", "command": "workbench.action.showCommands" },
 *     { "key": "cmd+p", "command": "-workbench.action.quickOpen" }   // remove a default
 *   ]
 *
 * A binding's command can be one of these, any command palette entry
 * (by its id — plugin commands included), or an editor action
 * (`editor.action.*`, Monaco's — the same ids as VS Code's).
 * Keys: `mod` is ⌘ on a Mac and Ctrl elsewhere.
 */

/** When a binding applies. */
type When = (event: KeyboardEvent) => boolean;

export interface ShortcutCommand {
  id: string;
  title: string;
  /** Default keys (any number); `mac` overrides on a Mac. */
  keys: string[];
  mac?: string[];
  when?: When;
  /** What "when" means, for the shortcut editor. */
  whenLabel?: string;
  run: (event: KeyboardEvent | null) => unknown;
}

const notInTerminal: When = (event) => !(event.target as HTMLElement | null)?.closest?.(".terminal-view");
const inEditor: When = (event) => event.target instanceof Element && !!event.target.closest(".monaco-editor");
const isSplit: When = () => useTabsStore.getState().groups.length > 1;
const markdownOpen: When = () => /\.(md|markdown|mdx)$/i.test(useTabsStore.getState().lastFilePath ?? "");

function zoomEditor(delta: number | null) {
  const { values, set } = useSettingsStore.getState();
  set("editor.fontSize", delta === null ? DEFAULT_SETTINGS["editor.fontSize"] : values["editor.fontSize"] + delta);
}

const ui = () => useUiStore.getState();
const tabs = () => useTabsStore.getState();
const debug = () => useDebugStore.getState();
const navigation = () => useNavigationStore.getState();

export const COMMANDS: ShortcutCommand[] = [
  { id: "workbench.action.showCommands", title: "Command palette", keys: ["mod+shift+p"], run: () => ui().openPalette("commands") },
  { id: "workbench.action.quickOpen", title: "Go to file", keys: ["mod+p"], run: () => ui().openPalette("files") },
  { id: "workbench.action.openSettings", title: "Open settings", keys: ["mod+,"], run: () => tabs().openSettings() },
  { id: "sable.agent.focus", title: "Focus AI agent", keys: ["mod+l"], run: () => ui().focusAgent() },
  { id: "sable.agent.toggle", title: "Toggle AI agent panel", keys: ["mod+alt+a"], run: () => ui().toggleAgent() },
  { id: "workbench.action.files.save", title: "Save", keys: ["mod+s"], run: () => tabs().activePath && tabs().saveTab(tabs().activePath!) },
  { id: "sable.run", title: "Run active file", keys: ["mod+r"], run: () => runActiveFile() },
  { id: "workbench.action.togglePanel", title: "Toggle bottom panel", keys: ["mod+j", "mod+`"], run: () => ui().toggleTerminal() },
  { id: "workbench.action.terminal.new", title: "New terminal", keys: ["ctrl+shift+`"], run: () => useTerminalStore.getState().newTerminal() },
  { id: "workbench.action.toggleSidebarVisibility", title: "Toggle sidebar", keys: ["mod+b"], run: () => ui().toggleSidebar() },
  { id: "workbench.action.files.openFolder", title: "Open folder", keys: ["mod+o"], run: () => openFolderDialog() },
  { id: "workbench.action.newWindow", title: "New window", keys: ["mod+shift+n"], run: () => void newWindow() },
  { id: "workbench.action.closeWindow", title: "Close window", keys: ["mod+shift+w"], run: () => void closeWindow() },
  { id: "workbench.action.addRootFolder", title: "Add folder to workspace", keys: [], run: () => void addFolderToWorkspace() },
  { id: "workbench.action.closeActiveEditor", title: "Close tab", keys: ["mod+w"], run: () => tabs().activePath && tabs().closeTab(tabs().activePath!) },
  { id: "workbench.action.splitEditorRight", title: "Split editor right", keys: ["mod+\\"], run: () => tabs().splitRight() },
  { id: "workbench.action.focusPreviousGroup", title: "Focus previous editor group", keys: ["mod+alt+left"], when: isSplit, whenLabel: "split", run: () => tabs().focusAdjacentGroup(-1) },
  { id: "workbench.action.focusNextGroup", title: "Focus next editor group", keys: ["mod+alt+right"], when: isSplit, whenLabel: "split", run: () => tabs().focusAdjacentGroup(1) },
  { id: "workbench.action.reopenClosedEditor", title: "Reopen closed tab", keys: ["mod+shift+t"], run: () => tabs().reopenClosedTab() },
  { id: "workbench.action.nextEditor", title: "Next tab", keys: ["ctrl+tab", "mod+shift+]"], run: () => tabs().cycleTab(1) },
  { id: "workbench.action.previousEditor", title: "Previous tab", keys: ["ctrl+shift+tab", "mod+shift+["], run: () => tabs().cycleTab(-1) },
  ...Array.from({ length: 9 }, (_, index): ShortcutCommand => ({
    id: `workbench.action.openEditorAtIndex${index + 1}`,
    title: index === 8 ? "Go to last tab" : `Go to tab ${index + 1}`,
    keys: [`mod+${index + 1}`],
    run: () => tabs().activateTabAt(index),
  })),
  { id: "sable.editor.zoomIn", title: "Editor zoom in", keys: ["mod+=", "mod+shift+="], run: () => zoomEditor(1) },
  { id: "sable.editor.zoomOut", title: "Editor zoom out", keys: ["mod+-"], run: () => zoomEditor(-1) },
  { id: "sable.editor.zoomReset", title: "Editor zoom reset", keys: ["mod+0"], run: () => zoomEditor(null) },
  { id: "workbench.action.navigateBack", title: "Navigate back", keys: ["alt+left", "mod+["], mac: ["cmd+[", "ctrl+-"], run: () => navigation().goBack() },
  { id: "workbench.action.navigateForward", title: "Navigate forward", keys: ["alt+right", "mod+]"], mac: ["cmd+]", "ctrl+shift+-"], run: () => navigation().goForward() },
  { id: "sable.test.runAtCursor", title: "Run the test at the cursor", keys: ["ctrl+shift+r"], run: () => useTestStore.getState().atCursor(false) },
  { id: "sable.test.debugAtCursor", title: "Debug the test at the cursor", keys: ["ctrl+shift+d"], run: () => useTestStore.getState().atCursor(true) },
  { id: "workbench.view.search", title: "Search in workspace", keys: ["mod+shift+f"], run: () => ui().setSidebarView("search") },
  { id: "workbench.view.scm", title: "Source control", keys: ["mod+shift+g"], run: () => ui().setSidebarView("git") },
  { id: "workbench.view.debug", title: "Run and debug view", keys: ["mod+shift+d"], run: () => ui().setSidebarView("debug") },
  { id: "sable.recentFiles", title: "Recent files", keys: ["mod+e"], run: () => ui().openPalette("recentFiles") },
  { id: "sable.recentLocations", title: "Recent locations", keys: ["mod+shift+e"], run: () => ui().openPalette("recentLocations") },
  { id: "workbench.action.showAllSymbols", title: "Go to symbol in the project", keys: ["mod+t", "mod+alt+o"], run: () => ui().openPalette("symbols") },
  { id: "sable.fileStructure", title: "File structure", keys: ["mod+f12"], mac: ["cmd+f12"], run: () => ui().openPalette("structure") },
  { id: "editor.action.goToTypeDefinition", title: "Go to type declaration", keys: ["mod+shift+b"], run: () => navigation().goToAtCursor("typeDefinition") },
  { id: "editor.action.goToImplementation", title: "Go to implementation", keys: ["mod+alt+b"], run: () => navigation().goToAtCursor("implementation") },
  { id: "sable.findUsages", title: "Find usages", keys: ["alt+f7"], run: () => navigation().findUsagesAtCursor() },
  { id: "sable.callHierarchy", title: "Call hierarchy", keys: ["ctrl+alt+h"], run: () => navigation().showCallHierarchy() },
  {
    id: "markdown.showPreviewToSide",
    title: "Markdown preview beside",
    keys: ["mod+shift+v"],
    when: markdownOpen,
    whenLabel: "Markdown file",
    run: () => tabs().openPreview(tabs().lastFilePath!, true),
  },
  { id: "sable.refactor.extractVariable", title: "Extract variable", keys: ["mod+alt+v"], when: inEditor, whenLabel: "editor", run: () => refactor("extractVariable") },
  { id: "sable.refactor.extractMethod", title: "Extract method", keys: ["mod+alt+m"], when: inEditor, whenLabel: "editor", run: () => refactor("extractMethod") },
  { id: "sable.refactor.extractConstant", title: "Extract constant", keys: ["mod+alt+c"], when: inEditor, whenLabel: "editor", run: () => refactor("extractConstant") },
  { id: "sable.refactor.inline", title: "Inline", keys: ["mod+alt+n"], when: inEditor, whenLabel: "editor", run: () => refactor("inline") },
  { id: "sable.refactor.this", title: "Refactor this…", keys: [], mac: ["ctrl+t"], when: inEditor, whenLabel: "editor", run: () => refactorThis() },
  { id: "workbench.action.debug.start", title: "Start debugging / continue", keys: ["f5"], when: notInTerminal, whenLabel: "not in a terminal", run: () => debug().start() },
  { id: "workbench.action.debug.stop", title: "Stop debugging", keys: ["shift+f5"], when: notInTerminal, whenLabel: "not in a terminal", run: () => debug().stop() },
  { id: "workbench.action.debug.restart", title: "Restart debugging", keys: ["mod+shift+f5"], when: notInTerminal, whenLabel: "not in a terminal", run: () => debug().restart() },
  { id: "workbench.action.debug.pause", title: "Pause", keys: ["f6"], when: notInTerminal, whenLabel: "not in a terminal", run: () => debug().pause() },
  {
    id: "editor.debug.action.toggleBreakpoint",
    title: "Toggle breakpoint",
    keys: ["f9"],
    when: notInTerminal,
    whenLabel: "not in a terminal",
    run: () => {
      const path = tabs().lastFilePath;
      const line = getEditor()?.getPosition()?.lineNumber;
      if (path && line) useBreakpointsStore.getState().toggle(path, line);
    },
  },
  { id: "workbench.action.debug.stepOver", title: "Step over", keys: ["f10"], when: notInTerminal, whenLabel: "not in a terminal", run: () => debug().stepOver() },
  { id: "workbench.action.debug.stepInto", title: "Step into", keys: ["f11"], when: notInTerminal, whenLabel: "not in a terminal", run: () => debug().stepInto() },
  { id: "workbench.action.debug.stepOut", title: "Step out", keys: ["shift+f11"], when: notInTerminal, whenLabel: "not in a terminal", run: () => debug().stepOut() },
];

/** Shortcuts handled elsewhere (shown in the editor, not rebindable here). */
export const FIXED_SHORTCUTS: { keys: string; title: string }[] = [
  { keys: "⇧ ⇧", title: "Search Everywhere (files, symbols, actions)" },
  { keys: "Mouse back / forward", title: "Navigate back / forward" },
];

/** Editor actions with their own (Monaco) keys, listed for rebinding. */
export const EDITOR_ACTIONS: { id: string; title: string; keys: string[]; mac?: string[] }[] = [
  { id: "editor.action.rename", title: "Rename symbol", keys: ["f2", "shift+f6"] },
  { id: "editor.action.revealDefinition", title: "Go to definition", keys: ["f12"] },
  { id: "editor.action.referenceSearch.trigger", title: "Peek usages", keys: ["shift+f12"] },
  { id: "editor.action.quickFix", title: "Quick fix", keys: ["mod+."] },
  { id: "editor.action.marker.nextInFiles", title: "Next problem", keys: ["f8"] },
  { id: "editor.action.marker.prevInFiles", title: "Previous problem", keys: ["shift+f8"] },
  { id: "editor.action.formatDocument", title: "Format document", keys: ["shift+alt+f"] },
  { id: "editor.action.commentLine", title: "Toggle line comment", keys: ["mod+/"] },
  { id: "editor.action.addSelectionToNextFindMatch", title: "Add next occurrence to selection", keys: ["mod+d"] },
  { id: "editor.action.copyLinesDownAction", title: "Copy line down", keys: ["shift+alt+down"] },
  { id: "editor.action.moveLinesDownAction", title: "Move line down", keys: ["alt+down"] },
  { id: "editor.action.moveLinesUpAction", title: "Move line up", keys: ["alt+up"] },
  { id: "editor.action.deleteLines", title: "Delete line", keys: ["mod+shift+k"] },
  { id: "editor.action.insertCursorAbove", title: "Add cursor above", keys: ["ctrl+alt+up"], mac: ["cmd+alt+up"] },
  { id: "editor.action.insertCursorBelow", title: "Add cursor below", keys: ["ctrl+alt+down"], mac: ["cmd+alt+down"] },
  { id: "editor.action.triggerSuggest", title: "Trigger suggestions", keys: ["ctrl+space"] },
  { id: "actions.find", title: "Find", keys: ["mod+f"] },
  { id: "editor.action.startFindReplaceAction", title: "Replace", keys: ["mod+h"], mac: ["cmd+alt+f"] },
];

// --- Your keybindings.json ---------------------------------------------------------

export interface UserBinding {
  key: string;
  /** "-id" removes that command's binding on `key`. */
  command: string;
  args?: unknown;
}

export { parseJsonc } from "./jsonc";

interface ShortcutState {
  user: UserBinding[];
  /** keybindings.json's problem, if it couldn't be read. */
  error: string | null;
  filePath: string | null;
  load: () => Promise<void>;
  /** Replace a command's keys (null: back to its defaults). */
  setKeys: (command: string, keys: string[] | null) => Promise<void>;
}

/** keybindings.json, beside settings.json. */
export function keybindingsPath(): string | null {
  const settings = useSettingsStore.getState().filePath;
  if (!settings) return null;
  const separator = settings.includes("\\") ? "\\" : "/";
  return settings.slice(0, settings.lastIndexOf(separator)) + separator + "keybindings.json";
}

const FILE_HEADER = `// Your keyboard shortcuts. VS Code's format: { "key": "…", "command": "…" };
// "-command" removes a default key. \`mod\` is ⌘ on a Mac and Ctrl elsewhere.
// Settings → Keyboard Shortcuts edits this file for you.
`;

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  user: [],
  error: null,
  filePath: null,
  load: async () => {
    const path = keybindingsPath();
    if (!path) return;
    const text = await readFile(path).catch(() => null);
    if (text === null) {
      set({ user: [], error: null, filePath: path });
      return;
    }
    try {
      const parsed = parseJsonc(text);
      const list = (Array.isArray(parsed) ? parsed : []).filter(
        (entry): entry is UserBinding => !!entry && typeof entry.key === "string" && typeof entry.command === "string",
      );
      set({ user: list, error: null, filePath: path });
    } catch (error) {
      set({ error: `keybindings.json: ${error instanceof Error ? error.message : String(error)}`, filePath: path });
    }
    applyEditorBindings();
  },
  setKeys: async (command, keys) => {
    const path = get().filePath ?? keybindingsPath();
    if (!path) return;
    // Drop what the file says about this command, then (for new keys)
    // remove its defaults and add the new ones.
    const rest = get().user.filter((entry) => entry.command !== command && entry.command !== `-${command}`);
    const additions: UserBinding[] = [];
    if (keys) {
      for (const key of defaultKeysFor(command)) additions.push({ key, command: `-${command}` });
      for (const key of keys) additions.push({ key, command });
    }
    const user = [...rest, ...additions];
    await writeFile(path, `${FILE_HEADER}${JSON.stringify(user, null, 2)}\n`);
    set({ user, error: null, filePath: path });
    applyEditorBindings();
    broadcast("sable:keybindings-changed");
  },
}));

const keysForOs = (entry: { keys: string[]; mac?: string[] }) => (isMac() && entry.mac ? entry.mac : entry.keys);

/** A command's default keys on this OS. */
export function defaultKeysFor(command: string): string[] {
  const builtin = COMMANDS.find((entry) => entry.id === command) ?? EDITOR_ACTIONS.find((entry) => entry.id === command);
  return builtin ? keysForOs(builtin) : [];
}

const normalizeKey = (key: string) => key.toLowerCase().replace(/\s*\+\s*/g, "+").trim();

/** The keys a command has now (defaults, minus removals, plus yours). */
export function keysFor(command: string, user = useShortcutStore.getState().user): string[] {
  const removed = new Set(user.filter((entry) => entry.command === `-${command}`).map((entry) => normalizeKey(entry.key)));
  const keys = defaultKeysFor(command).filter((key) => !removed.has(normalizeKey(key)));
  for (const entry of user) if (entry.command === command && !keys.includes(entry.key)) keys.push(entry.key);
  return keys;
}

export const displayKeys = (keys: string[]) => keys.map(formatKey).join("  /  ");

// --- Running them ---------------------------------------------------------------------

interface Resolved {
  key: ParsedKey;
  command: string;
  when?: When;
}

/** The command palette registers how to run its entries by id. */
export function setPaletteRunner(run: (id: string) => boolean): void {
  paletteRunner.run = run;
}

/** Every binding that applies now, yours first (they win). */
function resolved(): Resolved[] {
  const user = useShortcutStore.getState().user;
  const list: Resolved[] = [];
  for (const entry of user) {
    // Removals, and editor actions (bound inside Monaco: applyEditorBindings).
    const editorAction = /^(editor\.|actions\.)/.test(entry.command) && !COMMANDS.some((c) => c.id === entry.command);
    if (entry.command.startsWith("-") || editorAction) continue;
    const key = parseKey(entry.key);
    if (key) list.push({ key, command: entry.command, when: COMMANDS.find((c) => c.id === entry.command)?.when });
  }
  for (const command of COMMANDS) {
    for (const raw of keysFor(command.id, user)) {
      if (user.some((entry) => entry.command === command.id && normalizeKey(entry.key) === normalizeKey(raw))) continue;
      const key = parseKey(raw);
      if (key) list.push({ key, command: command.id, when: command.when });
    }
  }
  return list;
}

let cache: { user: UserBinding[]; list: Resolved[] } | null = null;

/** Run the command bound to this key press, if any. */
export function dispatchShortcut(event: KeyboardEvent): boolean {
  if (vimOwnsKey(event)) return false;
  const user = useShortcutStore.getState().user;
  if (!cache || cache.user !== user) cache = { user, list: resolved() };
  for (const binding of cache.list) {
    if (!matchesKey(event, binding.key) || (binding.when && !binding.when(event))) continue;
    return runCommandById(binding.command, event);
  }
  return false;
}

/** Run a command by id: Sable's, a palette entry's, or an editor action. */
export function runCommandById(id: string, event: KeyboardEvent | null = null): boolean {
  const builtin = COMMANDS.find((command) => command.id === id);
  if (builtin) {
    void Promise.resolve(builtin.run(event)).catch((error) => useUiStore.getState().setLastError(String(error)));
    return true;
  }
  if (paletteRunner.run?.(id)) return true;
  const action = getEditor()?.getAction(id);
  if (action) {
    void action.run();
    return true;
  }
  return false;
}

// --- Editor actions: rebound inside Monaco itself ----------------------------------------

let editorRules: { dispose(): void }[] = [];

/** keybindings.json entries for editor actions become Monaco keybinding
 *  rules (and "-editor.action…" removes Monaco's default). */
function applyEditorBindings() {
  void import("./editorRegistry").then(async ({ whenMonaco }) => {
    const monaco = await whenMonaco();
    for (const rule of editorRules) rule.dispose();
    editorRules = [];
    for (const entry of useShortcutStore.getState().user) {
      const command = entry.command.replace(/^-/, "");
      if (!command.startsWith("editor.") && !command.startsWith("actions.")) continue;
      if (COMMANDS.some((c) => c.id === command)) continue;
      const keybinding = monacoKeybinding(monaco, entry.key);
      if (keybinding === null) continue;
      const disposable = monaco.editor.addKeybindingRule({ keybinding, command: entry.command });
      if (disposable) editorRules.push(disposable);
    }
  });
}

type MonacoLike = typeof import("monaco-editor");

/** "mod+shift+k" → Monaco's keybinding number. */
function monacoKeybinding(monaco: MonacoLike, raw: string): number | null {
  const key = parseKey(raw);
  if (!key) return null;
  const { KeyMod, KeyCode } = monaco;
  let code: number | undefined;
  const name = key.key;
  if (/^Key[A-Z]$/.test(name)) code = KeyCode[name as keyof typeof KeyCode] as number;
  else if (/^Digit\d$/.test(name)) code = KeyCode[name as keyof typeof KeyCode] as number;
  else if (/^F\d+$/.test(name)) code = KeyCode[name as keyof typeof KeyCode] as number;
  else {
    const map: Record<string, keyof typeof KeyCode> = {
      arrowup: "UpArrow", arrowdown: "DownArrow", arrowleft: "LeftArrow", arrowright: "RightArrow", enter: "Enter", escape: "Escape",
      tab: "Tab", backspace: "Backspace", delete: "Delete", " ": "Space", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
      Quote: "Quote", Semicolon: "Semicolon", Comma: "Comma", Period: "Period", Slash: "Slash", Backslash: "Backslash",
      BracketLeft: "BracketLeft", BracketRight: "BracketRight", Minus: "Minus", Equal: "Equal", Backquote: "Backquote",
    };
    const mapped = map[name];
    if (mapped) code = KeyCode[mapped] as number;
  }
  if (code === undefined) return null;
  const mac = isMac();
  let value = code;
  if (key.shift) value |= KeyMod.Shift;
  if (key.alt) value |= KeyMod.Alt;
  // Monaco: CtrlCmd is ⌘ on a Mac (Ctrl elsewhere); WinCtrl is the other.
  if (key.meta) value |= mac ? KeyMod.CtrlCmd : KeyMod.WinCtrl;
  if (key.ctrl) value |= mac ? KeyMod.WinCtrl : KeyMod.CtrlCmd;
  return value;
}

// Saving keybindings.json in Sable applies it.
onPluginEvent((name, { path }) => {
  if (name === "didSave" && path && path === useShortcutStore.getState().filePath) {
    void useShortcutStore.getState().load();
    broadcast("sable:keybindings-changed");
  }
});
