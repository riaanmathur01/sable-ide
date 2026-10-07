import { useEffect, useRef, useState } from "react";
import { useDebugStore } from "../../store/debugStore";
import "./Debug.css";

/**
 * Debug console: program output (stdout/stderr) and an input that
 * evaluates expressions in the paused frame, like a REPL.
 */
export function DebugConsole() {
  const lines = useDebugStore((state) => state.consoleLines);
  const isPaused = useDebugStore((state) => state.isPaused);
  const evaluate = useDebugStore((state) => state.evaluate);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Stick to the bottom as output arrives.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <div className="debug-console">
      <div className="debug-console-output" ref={scrollRef}>
        {lines.length === 0 && (
          <div className="debug-console-line console">
            Program output appears here while debugging.
          </div>
        )}
        {lines.map((line) => (
          <div key={line.id} className={`debug-console-line ${line.category}`}>
            {line.category === "input" ? `› ${line.text}` : line.text}
          </div>
        ))}
      </div>
      <input
        className="debug-console-input"
        placeholder={
          isPaused ? "Evaluate expression…" : "Pause the program to evaluate"
        }
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && input.trim()) {
            void evaluate(input);
            setHistory((current) => [...current, input]);
            setHistoryIndex(null);
            setInput("");
          } else if (event.key === "ArrowUp" && history.length > 0) {
            event.preventDefault();
            const index =
              historyIndex === null
                ? history.length - 1
                : Math.max(0, historyIndex - 1);
            setHistoryIndex(index);
            setInput(history[index]);
          } else if (event.key === "ArrowDown" && historyIndex !== null) {
            event.preventDefault();
            const index = historyIndex + 1;
            if (index >= history.length) {
              setHistoryIndex(null);
              setInput("");
            } else {
              setHistoryIndex(index);
              setInput(history[index]);
            }
          }
        }}
      />
    </div>
  );
}
