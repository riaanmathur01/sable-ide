# Case Converter

Changes the case of names and text: rename `userProfileId` to
`user_profile_id`, `UserProfileId`, `USER_PROFILE_ID`, and so on.

## Renaming a symbol (F2)

1. Put the cursor on a variable, function, class or other name.
2. Press **F2** (or ⇧F6, as in JetBrains IDEs) to rename it.
3. Under the rename box, Case Converter lists the name in the other
   cases. Press ↓ to choose one and **Enter** to rename, or keep typing
   your own name.

For `userProfileId` it offers:

| Case | Suggestion |
| ---- | ---------- |
| PascalCase | `UserProfileId` |
| snake_case | `user_profile_id` |
| CONSTANT_CASE | `USER_PROFILE_ID` |
| camelCase | (shown when the name isn't camelCase already) |
| kebab-case | `user-profile-id` (CSS, SCSS, Less and HTML only) |

It's a real rename: with a language server running, every reference in
the project changes, not just the one under the cursor. Without one, all
of the name's uses in the file change.

## Converting selected text (command palette)

For text that isn't a name (a heading, a list, a phrase):

1. **Select** the text. It can be one word, a phrase, or several lines
   (each line converts separately).
2. Open the **command palette**: ⇧⌘P (Ctrl+Shift+P on Windows/Linux).
3. Run **Case Converter: Convert Case…** (typing `case` finds it).
4. Pick the case you want. Each option shows a preview of your selection
   converted. Press Enter.

The selection is replaced in one step: ⌘Z undoes it.

Each case also has its own command, such as **Case Converter: Convert to
snake_case**, so typing `snake` in the palette goes straight to it.

## The cases

| Case | `user profile ID` becomes |
| ---- | ------------------------- |
| camelCase | `userProfileId` |
| PascalCase | `UserProfileId` |
| snake_case | `user_profile_id` |
| kebab-case | `user-profile-id` |
| CONSTANT_CASE | `USER_PROFILE_ID` |
| dot.case | `user.profile.id` |
| Title Case | `User Profile Id` |
| Sentence case | `User profile id` |
| UPPERCASE / lowercase | `USER PROFILE ID` / `user profile id` |

It reads words from any style: `parseHTTPResponse`, `max_retry-count`
and `Some Title` all split into their words correctly. Acronyms stay
together (`parseHTTPResponse` → `parse_http_response`).

Permissions: `editor` (to read and change the file). Needs Sable 0.3.4 or
newer.
