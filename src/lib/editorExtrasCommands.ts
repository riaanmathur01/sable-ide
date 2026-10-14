import { useSettingsStore, type SettingKey } from "../store/settingsStore";
import { getEditor } from "./editorRegistry";
import { focusBreadcrumbs } from "./breadcrumbs/focus";

/**
 * Command palette entries for the breadcrumbs, Emmet and the spell
 * checker. Emmet's commands load with the editor (lib/emmet), so they're
 * imported when run — the palette stays free of Monaco.
 */
export interface ExtraCommand {
  id: string;
  label: string;
  detail?: string;
  run: () => void;
}

function toggle(key: SettingKey) {
  const { values, set } = useSettingsStore.getState();
  set(key, !values[key] as never);
}

type EmmetModule = typeof import("./emmet/emmetMonaco");

function emmet(run: (module: EmmetModule) => unknown) {
  return () => {
    getEditor()?.focus();
    void import("./emmet/emmetMonaco").then(run);
  };
}

export function editorExtrasCommands(): ExtraCommand[] {
  return [
    { id: "breadcrumbs-toggle", label: "View: Toggle Breadcrumbs", run: () => toggle("breadcrumbs.enabled") },
    { id: "breadcrumbs-focus", label: "View: Focus Breadcrumbs", detail: "⇧⌘.", run: () => void focusBreadcrumbs() },
    { id: "spell-check-toggle", label: "Spell Check: Toggle Spell Checking", run: () => toggle("spellCheck.enabled") },
    { id: "emmet-toggle", label: "Emmet: Toggle Emmet Abbreviations", run: () => toggle("emmet.enabled") },
    // VS Code's ids, so keybindings.json entries for them work.
    { id: "editor.emmet.action.wrapWithAbbreviation", label: "Emmet: Wrap with Abbreviation", run: emmet((module) => module.wrapWithAbbreviation()) },
    { id: "editor.emmet.action.balanceOut", label: "Emmet: Balance (outward)", run: emmet((module) => module.balance("outward")) },
    { id: "editor.emmet.action.balanceIn", label: "Emmet: Balance (inward)", run: emmet((module) => module.balance("inward")) },
    { id: "editor.emmet.action.matchTag", label: "Emmet: Go to Matching Pair", run: emmet((module) => module.goToMatchingPair()) },
    { id: "editor.emmet.action.removeTag", label: "Emmet: Remove Tag", run: emmet((module) => module.removeTag()) },
    { id: "editor.emmet.action.updateTag", label: "Emmet: Update Tag", run: emmet((module) => module.updateTag()) },
  ];
}
