# React Snippets

Type a short prefix in a React file and pick the snippet from the
suggestions to insert a component or hook. Press Tab to move between the
placeholders.

| Prefix | Inserts |
| ------ | ------- |
| `rfc` | `export default function Name(props) { return (<div></div>); }` |
| `rafce` | `const Name = (props) => { … };` and `export default Name;` |
| `useState` | `const [value, setValue] = useState(initialValue);` (renaming `value` renames `setValue`) |
| `useEffect` | `useEffect(() => { … }, [dependencies]);` |
| `useRef` | `const ref = useRef(null);` |
| `useMemo` | `const value = useMemo(() => compute(), [dependencies]);` |
| `useCallback` | `const handleClick = useCallback((event) => { … }, [dependencies]);` |
| `useContext` | `const value = useContext(MyContext);` |
| `createContext` | `export const MyContext = createContext(null);` |
| `imr` | `import React from "react";` |
| `imrs` | `import React, { useState, useEffect } from "react";` |
| `dprops` | `const { children } = props;` |

## How to use

1. Open a `.jsx`, `.tsx`, `.js` or `.ts` file.
2. At the start of a line, type a prefix such as `rfc` or `useSt`.
3. Choose the snippet in the suggestions (its details show what it
   inserts) and press Enter.
4. Type over the first placeholder, then press Tab to go to the next.

Component snippets are named after the file: `user-card.tsx` gives
`UserCard`, and `NavBar/index.jsx` gives `NavBar`.

Permissions: `editor` (for the suggestions). Needs Sable 0.3.3 or newer.
