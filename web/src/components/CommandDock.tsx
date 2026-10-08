import { useEffect, useRef, useState } from "react";
import { ArrowUp, Sparkles, Square } from "lucide-react";

const SUGGESTIONS = [
  "Draw a login flow: user, web app, auth service, database",
  "Add a sticky note that says ship by Friday",
  "Title: Q3 architecture review",
  "Make the database green and move it down",
];

interface Props {
  showSuggestions: boolean;
  running: boolean;
  disabled?: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function CommandDock({ showSuggestions, running, disabled, onSubmit, onCancel }: Props) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the command bar from anywhere (unless the user is typing in the canvas).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName));
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const submit = (value = text) => {
    const v = value.trim();
    if (!v || disabled) return;
    onSubmit(v);
    setText("");
  };

  return (
    <div className="dock" role="region" aria-label="AI command bar">
      {showSuggestions && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => submit(s)} disabled={disabled}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className={`bar${running ? " is-running" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Sparkles className="bar-icon" size={18} aria-hidden />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (running) onCancel();
              else inputRef.current?.blur();
            }
          }}
          placeholder={disabled ? "Connect the server to start drawing…" : "Tell the board what to draw…"}
          aria-label="Command"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        {!text && !running && <kbd className="hint">/</kbd>}
        {running ? (
          <button type="button" className="send stop" onClick={onCancel} aria-label="Stop">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!text.trim() || disabled} aria-label="Run command">
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        )}
      </form>
    </div>
  );
}
