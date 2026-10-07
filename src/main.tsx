import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./lib/theme.css";
import { registerBundledFonts } from "./lib/fonts";
import { applyUiTheme, cachedThemeId } from "./lib/themes";

// The bundled JetBrains Mono, before anything measures text.
registerBundledFonts();

// Text fields are for code, file names and commands: turn off the OS's
// auto-capitalization, autocorrect and spellcheck everywhere (macOS's
// webview otherwise turns "main.py" into "Main.py"). Applied on focus,
// so every input — including ones added later — is covered before the
// first keystroke.
document.addEventListener(
  "focusin",
  (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
    field.setAttribute("autocapitalize", "off");
    field.setAttribute("autocorrect", "off");
    field.setAttribute("autocomplete", "off");
    field.spellcheck = false;
  },
  true,
);

// Paint last session's theme before React renders (no default flash).
applyUiTheme(cachedThemeId());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
