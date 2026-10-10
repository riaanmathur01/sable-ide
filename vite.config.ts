import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Monaco is lazy-loaded at runtime; pre-bundle it so Vite doesn't
  // discover it mid-session, re-optimize, and hard-reload the page
  // (which would wipe all app state the first time a file is opened).
  optimizeDeps: {
    include: [
      "monaco-editor",
      "@monaco-editor/react",
      "@xterm/xterm",
      "@xterm/addon-fit",
      // TextMate highlighting (src/lib/shikiMonaco.ts). Grammars are
      // dynamic imports; listing them stops Vite from discovering them
      // mid-session (which would reload the page).
      "shiki/core",
      "shiki/engine/javascript",
      "@shikijs/vscode-textmate",
      "@shikijs/themes/catppuccin-latte",
      "@shikijs/themes/catppuccin-frappe",
      "@shikijs/themes/catppuccin-macchiato",
      "@shikijs/themes/catppuccin-mocha",
      "@shikijs/langs/c",
      "@shikijs/langs/cpp",
      "@shikijs/langs/csharp",
      "@shikijs/langs/css",
      "@shikijs/langs/dart",
      "@shikijs/langs/dockerfile",
      "@shikijs/langs/go",
      "@shikijs/langs/graphql",
      "@shikijs/langs/html",
      "@shikijs/langs/ini",
      "@shikijs/langs/java",
      "@shikijs/langs/json",
      "@shikijs/langs/jsx",
      "@shikijs/langs/kotlin",
      "@shikijs/langs/less",
      "@shikijs/langs/lua",
      "@shikijs/langs/markdown",
      "@shikijs/langs/perl",
      "@shikijs/langs/php",
      "@shikijs/langs/powershell",
      "@shikijs/langs/python",
      "@shikijs/langs/r",
      "@shikijs/langs/ruby",
      "@shikijs/langs/rust",
      "@shikijs/langs/scala",
      "@shikijs/langs/scss",
      "@shikijs/langs/shellscript",
      "@shikijs/langs/sql",
      "@shikijs/langs/swift",
      "@shikijs/langs/tsx",
      "@shikijs/langs/xml",
      "@shikijs/langs/yaml",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
