> Converted from the VS Code extension **alonsodomin.blueforest-theme** 0.3.2 by Sable. Choose a theme in Settings → Editor Appearance → Color Theme, or with "Color Theme: …" in the command palette (⇧⌘P).

Themes:

- BlueForest

# Blueforest Theme

A dark blue theme inspired by the [Blueforest IntelliJ](https://github.com/sirthias/BlueForest) theme. It has been
optimised for syntax higlighting the following languages:

 * Groovy
 * Haskell
 * HTML
 * Java
 * Markdown
 * Python
 * Scala
 * C / C++
 * Bash
 * Powershell
 * JSON
 * XML / Html
 * Golang
 * GLSL
 * YAML

## Working with these sources

This repository comes with a Nix flake that sets up a development shell that comes with its own help menu regarding commands available. Simply run `nix develop` at the root of this repository and you'll see the following:

```bash
🔨 Welcome to blueforest

[[general commands]]

  menu    - prints this menu

[formatters]

  nixfmt  - Nix code formatter

[utilities]

  package - Build the .vsix extension package
  release - Interactive release helper
```

### Releases

Releases are managed by the tooling here, you can trigger a release by either running `nix run .#release` or by simply running `release` from the previously mentioned shell.