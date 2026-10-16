import { isMac } from "../../lib/plugins/keybindings";

/** ⌘ on a Mac, Ctrl elsewhere (for shortcut hints). */
export const modKey = () => (isMac() ? "⌘" : "Ctrl+");
