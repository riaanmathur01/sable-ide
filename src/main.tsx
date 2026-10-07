import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./lib/theme.css";
import { registerBundledFonts } from "./lib/fonts";
import { applyUiTheme, cachedThemeId } from "./lib/themes";

// The bundled JetBrains Mono, before anything measures text.
registerBundledFonts();

// Paint last session's theme before React renders (no default flash).
applyUiTheme(cachedThemeId());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
