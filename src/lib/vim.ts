import type * as MonacoTypes from "monaco-editor";
import { useTabsStore } from "../store/tabsStore";
import { isMac } from "./plugins/keybindings";

/**
 * Vim mode (Settings → Editor → Vim Mode), via monaco-vim — loaded only
 * when it's turned on. Each editor gets its own Vim state and a mode line
 * (the `:` command line lives there too). :w, :q, :wq and :x save and
 * close tabs.
 */

type VimModule = typeof import("monaco-vim");
let vimModule: Promise<VimModule> | null = null;
let exCommandsDefined = false;
let enabled = false;

/** Whether Vim mode is on (for the shortcut dispatcher). */
export function vimEnabled(): boolean {
  return enabled;
}

export function setVimEnabled(value: boolean): void {
  enabled = value;
}

function loadVim(): Promise<VimModule> {
  vimModule ??= import("monaco-vim").then((module) => {
    if (!exCommandsDefined) {
      exCommandsDefined = true;
      // monaco-vim's Vim object (CodeMirror's Vim API).
      const Vim = (module.VimMode as unknown as { Vim: { defineEx(name: string, prefix: string, run: () => void): void } }).Vim;
      const tabs = () => useTabsStore.getState();
      const save = () => (tabs().activePath ? tabs().saveTab(tabs().activePath!) : Promise.resolve());
      const close = () => (tabs().activePath ? tabs().closeTab(tabs().activePath!) : Promise.resolve());
      Vim.defineEx("write", "w", () => void save());
      Vim.defineEx("quit", "q", () => void close());
      Vim.defineEx("wq", "wq", () => void save().then(close));
      Vim.defineEx("xit", "x", () => void save().then(close));
    }
    return module;
  });
  return vimModule;
}

/** Turn Vim on for `editor`, showing its mode in `statusNode`. Returns the way to turn it off. */
export async function attachVim(
  editor: MonacoTypes.editor.IStandaloneCodeEditor,
  statusNode: HTMLElement,
): Promise<() => void> {
  const { initVimMode } = await loadVim();
  const vim = initVimMode(editor, statusNode);
  return () => {
    vim.dispose();
    statusNode.textContent = "";
  };
}

/** Ctrl keys Vim uses in normal/visual mode; on Windows/Linux they'd
 *  otherwise be Sable shortcuts (Ctrl is Sable's ⌘ there). */
const VIM_CTRL_KEYS = new Set(["KeyR", "KeyO", "KeyI", "KeyB", "KeyF", "KeyD", "KeyU", "KeyE", "KeyY", "KeyV", "KeyA", "KeyX", "BracketLeft", "KeyW"]);

/** Whether a key press belongs to Vim rather than to a Sable shortcut. */
export function vimOwnsKey(event: KeyboardEvent): boolean {
  if (!enabled || isMac()) return false;
  if (!(event.target instanceof Element) || !event.target.closest(".monaco-editor")) return false;
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && VIM_CTRL_KEYS.has(event.code);
}
