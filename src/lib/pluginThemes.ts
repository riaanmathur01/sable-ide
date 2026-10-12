import { invokeLocal } from "./backend";
import { parseJsonc } from "./jsonc";
import { pluginThemeOwners, setPluginThemes } from "./themes";
import { themeFromVscode, type VscodeThemeJson } from "./vscodeTheme";
import type { PluginInfo } from "./plugins/types";

/**
 * Themes from plugins: each enabled plugin's `themes` (VS Code color-theme
 * JSON files) become Sable themes (lib/vscodeTheme.ts). They don't need
 * the plugin to run, so they load with the plugin list, ahead of plugins'
 * code.
 */

/** A plugin theme's id as Sable (and Monaco, which allows only letters,
 *  digits and dashes in theme names) knows it. */
export function themeId(id: string): string {
  return id.replace(/[^A-Za-z0-9-]+/g, "-");
}

/** What each plugin's themes were loaded from, to skip unchanged ones. */
const loaded = new Map<string, string>();

function signature(plugin: PluginInfo): string {
  return plugin.enabled ? `${plugin.path}@${plugin.manifest.version}:${JSON.stringify(plugin.manifest.themes ?? [])}` : "";
}

/** Bring the registered themes in line with `plugins`. */
export async function syncPluginThemes(plugins: PluginInfo[], options: { force?: string } = {}): Promise<void> {
  const present = new Set(plugins.map((plugin) => plugin.manifest.id));
  // Uninstalled plugins' themes go (including one cached from last time).
  for (const id of new Set([...loaded.keys(), ...pluginThemeOwners()])) {
    if (!present.has(id)) {
      loaded.delete(id);
      setPluginThemes(id, []);
    }
  }
  await Promise.all(
    plugins.map(async (plugin) => {
      const id = plugin.manifest.id;
      const wanted = plugin.manifest.themes?.length ? signature(plugin) : "";
      if (loaded.get(id) === wanted && options.force !== id) return;
      loaded.set(id, wanted);
      if (!wanted) {
        setPluginThemes(id, []);
        return;
      }
      const themes = await Promise.all(
        (plugin.manifest.themes ?? []).map(async (contribution) => {
          try {
            const text = await invokeLocal<string>("plugin_read_theme", { id, path: contribution.path });
            const json = parseJsonc(text) as VscodeThemeJson;
            return [themeFromVscode({ id: themeId(contribution.id), label: contribution.label, uiTheme: contribution.uiTheme, json })];
          } catch (error) {
            console.warn(`${plugin.manifest.name}: theme ${contribution.label} couldn't be loaded`, error);
            return [];
          }
        }),
      );
      setPluginThemes(id, themes.flat());
    }),
  );
}
