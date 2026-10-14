/**
 * Words that are right in code but missing from an English dictionary:
 * language keywords and builtins, common abbreviations, and tool and
 * library names. Together with cspell's software-terms list (loaded with
 * the dictionary) they keep the checker quiet about ordinary code.
 * Words under four letters are never checked, so they aren't listed.
 */
export const PROGRAMMING_TERMS = `
abstract alloc allocs anim apis appdata applet args argv argc arity async asyncio autofocus autocomplete autoload
autosave autosaved backend backends backoff basename bitfield bitmask bitwise boolean booleans breakpoint breakpoints
breadcrumb breadcrumbs bugfix builtin builtins bytecode callee callback callbacks camelcase charset checkbox
checksum chmod chown classname classnames clippy clojure cmake codebase codegen codepoint codepoints colorize
colorized combobox comparator concat config configs const consts constexpr cpus credential crypto csrf cwd
datetime dealloc debounce debounced debouncer decl decls decrement dedent dedup dedupe deduped deinit
deps deque deref dereference descriptor deserialize deserialized desktop destructure destructured dict dicts
diff diffs dirname dirs distro distros dockerfile dotenv dotfile dotfiles dropdown dropdowns dtype dylib
elif emoji emojis endian endif enum enums env envs errno eslint eval exe exec execs expr exprs extern
falsy fetchable filename filenames filepath filesystem filetype fixme fixup flatmap fmt formatter formatters
frontend fullscreen func funcs gettext getter getters gitignore github gitlab globals golang goroutine
goroutines gzip hashable hashmap hashset hostname hotkey hotkeys href hrefs html http https hunspell iconify
idempotent iframe iframes impl impls inbox init inits initializer inlined inlining instanceof int ints
interop iota isnt iterable iterables iterator iterators javadoc javascript jetbrains jsdoc json jsonc jsx
kbd keybinding keybindings keycode keydown keymap keypress keyup keyword kotlin kwarg kwargs lambda lang langs
linter linters localhost lookahead lookbehind lowercased lsp malloc memcpy memoize memoized metadata middleware
mixin mixins monaco monorepo multiline mutex namespace namespaced namespaces nbsp nonce noop npm nullable
nullish numpy onblur onchange onclick onfocus oninput onkeydown onload onmount onsubmit opcode param params
parens parsers passwd pathname pathnames pids plaintext pnpm polyfill polyfills popup popups postgres
postgresql preact prefetch preload preloaded prepend prepended prettier println printf proto protobuf
pseudocode pubsub pydantic pyright pytest quickfix quickfixes readonly rect rects redis redux refactor refactored
refactoring regex regexes regexp rehydrate rerender rerendered rerenders resize resized resizer resizable
rgba rustc rustfmt rustup sandboxed scrollable scrollbar scrollbars serde serializable sessionstorage
setter setters shiki sizeof skippable snprintf sprintf sqlite stacktrace stateful stderr stdin stdio
stdlib stdout strcmp strlen struct structs stylesheet stylesheets subclassed subcommand subcommands
subdir subdirs subfolder subfolders submodule submodules subprocess substring substrings sudo svelte
symlink symlinks syscall syscalls tauri textarea textmate thead todo todos tokenize tokenized tokenizer
tokenizers toolchain tooltip tooltips truthy tsconfig tsx typedef typedefs typeof uint unescape unicode
uniq unmount unmounted unmounts unregister unregistered unsubscribe untracked upsert uptime uuid uuids
validator varargs vararg vite vitest vscode vue webpack webview webviews websocket websockets whitespace
wildcard wildcards workspace workspaces wrapper xpath yaml zustand
cancelled cancelling ceil cbrt dialogs draggable droppable glyphs lookups luminance matcher matchers preselect
preselected reflow renderer renderers resolvers sortable strikethrough subarray unlisten unshift unclosed
mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave pointerdown pointermove pointerup
pointercancel keydown dblclick contextmenu dragstart dragend dragover dragleave beforeunload unhandledrejection
datalist srcdoc tablist toml woff woff2 webp avif ipynb graphql venv venvs virtualenv pyproject pathlib
itertools functools dataclasses defaultdict pprint textwrap heapq asyncio dunder fstring lucide catppuccin
oklch argb rrggbb rrggbbaa gradle gradlew mvnw debugpy pytest ipykernel kernelspec nbformat
`;
