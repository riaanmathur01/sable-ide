import {
  createHighlighterCore,
  type HighlighterCore,
  type ThemeRegistrationRaw,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
  EncodedTokenMetadata,
  INITIAL,
  type StateStack,
} from "@shikijs/vscode-textmate";
import type * as MonacoTypes from "monaco-editor";
import { THEMES, semanticRules, themeById, type ThemeDefinition, type ThemeId } from "./themes";

/**
 * TextMate-grammar highlighting for Monaco, via Shiki — the same
 * grammars VS Code uses, so builtins, method calls, f-string
 * placeholders, decorators, `self`, etc. each get their own color
 * (Monaco's built-in Monarch tokenizers can't tell these apart).
 *
 * Adapted from @shikijs/monaco with two fixes:
 *   - Tokens are named by their exact theme color index (`tm4_1` = color
 *     #4, italic) instead of being mapped back to a scope name, so colors
 *     are exact; and switching themes re-tokenizes, since indices are
 *     per-theme.
 *   - Languages without a grammar keep Monaco's Monarch tokenizer and
 *     the theme's Monarch rules, so they're still colored.
 *
 * Grammars load lazily, the first time a file of that language opens.
 */

type Monaco = typeof MonacoTypes;

let activeTheme = "sable-dark";
let tokenizeScopes: ((languageId: string, lines: string[]) => LineScopes[] | null) | null = null;

/** One TextMate token: [start, end) on its line and its scope stack. */
export interface ScopedToken {
  start: number;
  end: number;
  scopes: string[];
}
export type LineScopes = ScopedToken[];

/**
 * TextMate scopes for each line of `lines` (null if the language has no
 * grammar loaded yet). Used where a feature needs to know whether text is
 * code, a string or a comment.
 */
export function scopesForLines(languageId: string, lines: string[]): LineScopes[] | null {
  return tokenizeScopes?.(languageId, lines) ?? null;
}
const themeListeners = new Set<(id: string) => void>();

/** The editor theme currently applied. */
export function currentThemeId(): string {
  return activeTheme;
}

/** Run `listener` after every editor theme change. */
export function onThemeChange(listener: (id: string) => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

/** Monaco language id → Shiki grammar loader. TS/JS use the TSX/JSX
 *  grammars because Monaco opens .tsx/.jsx files as typescript/javascript. */
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  python: () => import("@shikijs/langs/python"),
  typescript: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  markdown: () => import("@shikijs/langs/markdown"),
  shell: () => import("@shikijs/langs/shellscript"),
  yaml: () => import("@shikijs/langs/yaml"),
  xml: () => import("@shikijs/langs/xml"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  csharp: () => import("@shikijs/langs/csharp"),
  sql: () => import("@shikijs/langs/sql"),
  lua: () => import("@shikijs/langs/lua"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  ini: () => import("@shikijs/langs/ini"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  perl: () => import("@shikijs/langs/perl"),
  powershell: () => import("@shikijs/langs/powershell"),
  graphql: () => import("@shikijs/langs/graphql"),
};

/** Shiki's grammar name for a Monaco language (where they differ). */
const GRAMMAR_NAME: Record<string, string> = {
  typescript: "tsx",
  javascript: "jsx",
  shell: "shellscript",
};

/** The minimap's visible-area slider: clearly visible on every theme
 *  (Monaco's default is a faint tint). */
const MINIMAP_SLIDER = {
  "minimapSlider.background": "#ffffff26",
  "minimapSlider.hoverBackground": "#ffffff38",
  "minimapSlider.activeBackground": "#ffffff4d",
};

const BASE_TOKEN_COLORS = {
  "catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
};

/** Build the TextMate theme Shiki tokenizes with. Pure. */
export function buildTextmateTheme(
  theme: ThemeDefinition,
  base: ThemeRegistrationRaw | null,
): ThemeRegistrationRaw {
  return {
    name: theme.id,
    type: "dark",
    colors: {
      "editor.background": theme.editor.colors["editor.background"],
      "editor.foreground": theme.foreground,
    },
    // vscode-textmate picks the most specific matching selector; among
    // equally specific ones, the later rule wins — so ours come last.
    settings: [
      { settings: { foreground: theme.foreground } },
      ...((base?.tokenColors ?? base?.settings ?? []).filter(
        (rule) => rule.scope !== undefined,
      )),
      ...theme.tokenColors,
    ],
  };
}

const FONT_STYLE_NAMES: [number, string][] = [
  [1, "italic"],
  [2, "bold"],
  [4, "underline"],
  [8, "strikethrough"],
];

/** Monaco rules for every (color index × font style) token name. */
function colorMapRules(colorMap: string[]) {
  const rules: { token: string; foreground?: string; fontStyle?: string }[] = [];
  colorMap.forEach((color, index) => {
    if (!color) return;
    const foreground = color.replace("#", "").slice(0, 6);
    for (let style = 0; style < 16; style++) {
      const fontStyle = FONT_STYLE_NAMES.filter(([bit]) => style & bit)
        .map(([, name]) => name)
        .join(" ");
      rules.push({ token: `tm${index}_${style}`, foreground, fontStyle });
    }
  });
  return rules;
}

class TokenizerState implements MonacoTypes.languages.IState {
  constructor(public readonly ruleStack: StateStack) {}
  clone() {
    return new TokenizerState(this.ruleStack);
  }
  equals(other: MonacoTypes.languages.IState) {
    return other instanceof TokenizerState && other.ruleStack === this.ruleStack;
  }
}

/**
 * Install TextMate highlighting. Returns immediately; Monarch colors show
 * until the highlighter is ready (a few ms), then grammars take over.
 */
export function installShikiHighlighting(monaco: Monaco, initialTheme: ThemeId) {
  let highlighter: HighlighterCore | null = null;
  let requestedTheme: string = initialTheme;
  const providers = new Map<string, MonacoTypes.IDisposable>();
  const loading = new Map<string, Promise<void>>();

  function tokensProvider(grammar: string): MonacoTypes.languages.TokensProvider {
    return {
      getInitialState: () => new TokenizerState(INITIAL),
      tokenize(line, state) {
        const ruleStack = (state as TokenizerState).ruleStack;
        if (!highlighter || line.length > 20_000) {
          return { endState: state, tokens: [{ startIndex: 0, scopes: "" }] };
        }
        const result = highlighter
          .getLanguage(grammar)
          .tokenizeLine2(line, ruleStack, 500);
        const tokens: MonacoTypes.languages.IToken[] = [];
        for (let index = 0; index < result.tokens.length; index += 2) {
          const metadata = result.tokens[index + 1];
          const color = EncodedTokenMetadata.getForeground(metadata);
          const style = Math.max(0, EncodedTokenMetadata.getFontStyle(metadata));
          tokens.push({ startIndex: result.tokens[index], scopes: `tm${color}_${style}` });
        }
        return { endState: new TokenizerState(result.ruleStack), tokens };
      },
    };
  }

  /** (Re)register a language's tokenizer; re-registering re-tokenizes
   *  every open model of that language. */
  function register(language: string) {
    providers.get(language)?.dispose();
    const grammar = GRAMMAR_NAME[language] ?? language;
    providers.set(
      language,
      monaco.languages.setTokensProvider(language, tokensProvider(grammar)),
    );
  }

  /** Define the Monaco theme for `id` from Shiki's color map for it. */
  function activate(id: string) {
    if (!highlighter) return;
    const theme = themeById(id);
    const { colorMap } = highlighter.setTheme(theme.id);
    monaco.editor.defineTheme(theme.id, {
      ...theme.editor,
      colors: { ...theme.editor.colors, ...MINIMAP_SLIDER },
      // Monarch fallback rules, the exact TextMate colors, then semantic
      // categories (sem-*; matched only by semantic tokens).
      rules: [...theme.editor.rules, ...colorMapRules(colorMap), ...semanticRules(theme)],
    });
  }

  // Wrap setTheme (used by the editor component) so every switch also
  // updates Shiki and re-tokenizes with the new theme's color indices.
  const originalSetTheme = monaco.editor.setTheme.bind(monaco.editor);
  monaco.editor.setTheme = (id: string) => {
    requestedTheme = id;
    activate(id);
    originalSetTheme(id);
    if (highlighter) for (const language of providers.keys()) register(language);
    activeTheme = id;
    for (const listener of themeListeners) listener(id);
  };

  async function ensureLanguage(language: string) {
    const loader = GRAMMARS[language];
    if (!loader || providers.has(language)) return;
    if (!loading.has(language)) {
      loading.set(
        language,
        (async () => {
          const ready = await initialized;
          await ready.loadLanguage(loader() as never);
          // Monaco installs its Monarch tokenizer through a lazy factory
          // that *registers on resolve* — if it resolved after us, it
          // would replace the grammar. colorize() awaits that factory, so
          // ours is guaranteed to be registered last.
          await monaco.editor.colorize("", language, {}).catch(() => "");
          register(language);
        })().catch((error) => {
          // Keep Monarch highlighting for this language.
          console.warn(`TextMate grammar for ${language} failed to load`, error);
        }),
      );
    }
    await loading.get(language);
  }

  tokenizeScopes = (languageId, lines) => {
    if (!highlighter || !providers.has(languageId)) return null;
    const grammar = highlighter.getLanguage(GRAMMAR_NAME[languageId] ?? languageId);
    let ruleStack = INITIAL;
    return lines.map((line) => {
      const result = grammar.tokenizeLine(line, ruleStack, 500);
      ruleStack = result.ruleStack;
      return result.tokens.map((token) => ({
        start: token.startIndex,
        end: Math.min(token.endIndex, line.length),
        scopes: token.scopes,
      }));
    });
  };

  const initialized = (async () => {
    const themes = await Promise.all(
      Object.values(THEMES).map(async (theme) => {
        const base = theme.baseTokenColors
          ? ((await BASE_TOKEN_COLORS[theme.baseTokenColors]()) as { default: ThemeRegistrationRaw })
              .default
          : null;
        return buildTextmateTheme(theme, base);
      }),
    );
    highlighter = await createHighlighterCore({
      themes,
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
    monaco.editor.setTheme(requestedTheme);
    return highlighter;
  })();

  // Load grammars for whatever is (or becomes) open.
  for (const model of monaco.editor.getModels()) {
    void ensureLanguage(model.getLanguageId());
  }
  monaco.editor.onDidCreateModel((model) => {
    void ensureLanguage(model.getLanguageId());
    model.onDidChangeLanguage((event) => void ensureLanguage(event.newLanguage));
  });
}
