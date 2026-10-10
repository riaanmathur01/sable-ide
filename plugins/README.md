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

## Your own marketplace

The marketplace is just this JSON file. To run your own (for a team, say),
host a file in the same format and point **Settings → Plugins →
Marketplace URL** at it.
