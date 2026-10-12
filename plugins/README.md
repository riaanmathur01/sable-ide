# Sable Marketplace

The plugins listed in Sable's marketplace (**Settings → Plugins →
Marketplace**). `registry.json` is the catalogue Sable downloads; each
folder here is one plugin.

## Listing your plugin

1. Write the plugin (**Settings → Plugins → Create** gets you started;
   the guide is [docs/plugins.md](../docs/plugins.md)) and publish it on
   GitHub: its own repository, or a folder in one.
2. Open a pull request adding an entry to `registry.json`:

```json
{
  "id": "your-plugin-id",
  "name": "Your Plugin",
  "version": "1.0.0",
  "description": "One line on what it does.",
  "author": "You",
  "permissions": ["editor"],
  "tags": ["editing"],
  "url": "https://github.com/you/your-plugin",
  "homepage": "https://github.com/you/your-plugin"
}
```

Optionally add `"readme": "<a raw README URL>"`. Without it, Sable shows
the `README.md` next to `sable-plugin.json` (worked out from a GitHub
`url`) on the plugin's **Details** page, so write one: it's what people
read before installing.

`url` is where Sable installs from. It can be a repository with
`sable-plugin.json` at the top, a `…/tree/<branch>/<folder>` link for a
plugin in a subfolder, or a link to a `.zip` / `.tar.gz`. The entry's
`version` and `permissions` must match the plugin's manifest. Users see
the permissions before installing, and an **Update** button when the
listed version is newer than theirs.

## Color themes

The theme plugins here (the `vscode.*` folders with a `themes/` folder)
are VS Code color-theme extensions from [Open VSX](https://open-vsx.org),
converted by Sable's own converter (**Plugins → Create → Convert a VS Code
extension**) with their code, if any, left out. Only extensions with a
permissive license (MIT, ISC, Apache-2.0, BSD, CC0, Unlicense) are
included, and each folder keeps its license file and the original
README. Their themes belong to their authors.

A theme plugin's entry may add `"themes"` (how many) and `"preview"`: the
colors of a small code sample on its Marketplace card
(`background`, `foreground`, `accent`, `keyword`, `string`, `function`,
`comment`, `type`), and is tagged `theme` to list it under Color Themes.

## Your own marketplace

The marketplace is just this JSON file. To run your own (for a team, say),
host a file in the same format and point **Settings → Plugins →
Marketplace URL** at it.
