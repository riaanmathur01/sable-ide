# Python Snippets

Type a short prefix in a Python file and pick the snippet from the
suggestions. Press Tab to move between the placeholders.

| Prefix | Inserts |
| ------ | ------- |
| `ifmain` | `if __name__ == "__main__":` guard |
| `dataclass` | a `@dataclass` class (import `dataclass` from `dataclasses`) |
| `class` | a class with `__init__` |
| `def` | a function with a docstring |
| `adef` | an `async def` with a docstring |
| `try` | `try` / `except … as error` / `finally` |
| `withopen` | `with open("file.txt", "r", encoding="utf-8") as f:` (pick the mode from a list) |
| `lc` | a list comprehension: `[x for x in items]` |
| `dc` | a dict comprehension: `{key: value for key, value in mapping.items()}` |
| `argparse` | a command-line program: `main()` with an `ArgumentParser`, and the main guard |
| `test` | a pytest test function with an `assert` |
| `logging` | `logging.basicConfig(…)` and a module `logger` (pick the level from a list) |
| `namedtuple` | a typed `NamedTuple` class (import `NamedTuple` from `typing`) |

## How to use

1. Open a `.py` file.
2. Type a prefix such as `ifmain` or `def` at the start of a line (`lc`
   and `dc` also work after `=` or inside a call).
3. Choose the snippet in the suggestions (its details show what it
   inserts) and press Enter.
4. Type over the first placeholder, then press Tab to go to the next.

Snippets are indented with 4 spaces and follow the indentation of the
line you insert them on.

Permissions: `editor` (for the suggestions). Needs Sable 0.3.3 or newer.
