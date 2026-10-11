import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { KeyRound } from "lucide-react";
import { invokeLocal } from "../../lib/backend";
import { useRemoteStore } from "../../store/remoteStore";
import "./AskpassDialog.css";

interface Prompt {
  id: number;
  prompt: string;
}

/**
 * What ssh asks while connecting — a password, a key's passphrase, a
 * one-time code (src-tauri/src/remote.rs runs Sable as ssh's askpass
 * helper). The answer goes straight back to ssh; Sable doesn't keep it.
 */
export function AskpassDialog() {
  const [queue, setQueue] = useState<Prompt[]>([]);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const label = useRemoteStore((state) => state.label);

  // Each prompt once, even if it's delivered twice.
  const seen = useRef(new Set<number>());
  useEffect(() => {
    const unlisten = listen<Prompt>("remote:askpass", ({ payload }) => {
      if (seen.current.has(payload.id)) return;
      seen.current.add(payload.id);
      setQueue((current) => [...current, payload]);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const current = queue[0];
  useEffect(() => {
    setValue("");
    if (current) setTimeout(() => input.current?.focus(), 0);
  }, [current]);

  if (!current) return null;
  const answer = (text: string | null) => {
    void invokeLocal("remote_askpass_answer", { id: current.id, answer: text });
    setQueue((rest) => rest.slice(1));
  };
  // A yes/no question (an unknown host's fingerprint) isn't secret.
  const question = /\(yes\/no/i.test(current.prompt);

  return (
    <div className="askpass-backdrop">
      <form
        className="askpass-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          answer(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") answer(null);
        }}
      >
        <div className="askpass-title">
          <KeyRound size={16} strokeWidth={1.5} />
          {label ? `Connecting to ${label}` : "SSH"}
        </div>
        <label className="askpass-prompt" htmlFor="askpass-input">
          {current.prompt}
        </label>
        <input
          id="askpass-input"
          ref={input}
          className="askpass-input"
          type={question ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="askpass-actions">
          <button type="button" className="askpass-button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="askpass-button primary">
            OK
          </button>
        </div>
      </form>
    </div>
  );
}
