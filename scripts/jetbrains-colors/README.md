# JetBrains colors

Sable's JetBrains themes (Darcula, Dark, Islands Dark) use the exact colors
JetBrains IDEs use, per language. This folder regenerates the color data,
`src/lib/jetbrains/schemes.generated.ts`, from the IDEs themselves.

## How JetBrains colors code

Every highlighted element has a *key*: `PY.SELF_PARAMETER`, `GO_PACKAGE`,
`org.rust.MUT_BINDING`, `INSTANCE_FIELD_ATTRIBUTES`, … A key's color comes
from the active scheme. When the scheme doesn't set it, the key falls back
to another one, usually a "language default", like this:
`KOTLIN_KEYWORD → JAVA_KEYWORD → DEFAULT_KEYWORD`.

- **Scheme values** live in XML inside the IDEs' jars. There's a base file
  per scheme, plus a file per language that each plugin registers as
  `additionalTextAttributes`.
- **Fallback chains** exist only in compiled code. `extract.py` reads them
  from the classes' static initializers with `javap`.

`extract.py` then resolves every key the way IntelliJ does (the rules are
described at the top of the script). For example, Dark and Islands Dark
inherit from Darcula, language files override the base scheme, and Darcula
never takes colors from the light scheme except as a last resort.

## Regenerating

You need a JDK (`javap`) and the IDEs. Each language comes from its own IDE:

| Languages | IDE |
| --------- | --- |
| Python | PyCharm (or CLion, which bundles Python CE) |
| JavaScript, TypeScript, CSS, HTML, SQL, YAML, Markdown, … | any of them |
| C, C++, Rust | CLion |
| Go | GoLand |
| PHP | PhpStorm |
| Ruby | RubyMine |
| C# | Rider |
| Java, Kotlin | fetched from the open-source IntelliJ repository |

You don't need to install them. Download the `.dmg` files and mount them
read-only, for example `hdiutil attach -readonly -nobrowse
GoLand-….dmg -mountpoint /tmp/goland`. Then run the script from the repo
root:

```sh
python3 scripts/jetbrains-colors/extract.py \
  --ide /Applications/CLion.app \
  --ide /tmp/goland/GoLand.app \
  --ide /tmp/rubymine/RubyMine.app \
  --ide /tmp/phpstorm/PhpStorm.app \
  --ide /tmp/rider/Rider.app \
  --ide /Applications/PyCharm.app \
  --out src/lib/jetbrains/schemes.generated.ts
```

The order sets priority: the first IDE that has a file wins. Put the newest
first. `--ide` also accepts a plugin `.zip` from the JetBrains Marketplace
(for example the Go plugin) in place of a whole IDE.

## The rest of the pipeline

- `src/lib/jetbrains/scopes.ts` decides which key each TextMate scope gets.
  It starts from IntelliJ's own TextMate table, then adds each language's
  native constructs.
- `src/lib/lsp/semanticTokens.ts` maps language-server tokens (parameters,
  fields, `self`, mutable bindings, …) to keys.
- `src/lib/jetbrains/tokenColors.ts` turns those into theme rules.
