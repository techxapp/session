import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, Sparkles, Square } from "lucide-react";
import type { VoiceState } from "../voice/useVoice";

const SUGGESTIONS = [
  "Draw a login flow: user, web app, auth service, database",
  "Add a sticky note that says ship by Friday",
  "Draw a house with a tree and a child next to it",
  "Make the database green and move it down",
];

interface Props {
  showSuggestions: boolean;
  running: boolean;
  disabled?: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /** Mic input (useVoice); the line being spoken shows in the empty input. */
  voice: { state: VoiceState; interim: string; error: string | null; toggle: () => void };
}

export function CommandDock({ showSuggestions, running, disabled, onSubmit, onCancel, voice }: Props) {
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

  const listening = voice.state === "listening";
  const busyMic = voice.state === "starting" || voice.state === "stopping";
  const placeholder = disabled
    ? "Connect the server to start drawing…"
    : voice.state === "off" && voice.error
      ? voice.error
      : listening || busyMic
        ? voice.interim || (listening ? "Listening… say a command" : "Starting the mic…")
        : "Tell the board what to draw…";

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
        className={`bar${running ? " is-running" : ""}${listening ? " is-listening" : ""}${voice.error && voice.state === "off" ? " has-error" : ""}`}
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
          placeholder={placeholder}
          aria-label="Command"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        {!text && !running && voice.state === "off" && <kbd className="hint">/</kbd>}
        <button
          type="button"
          className={`mic${listening ? " is-on" : ""}`}
          onClick={voice.toggle}
          disabled={disabled || voice.state === "stopping"}
          aria-pressed={listening}
          aria-label={listening ? "Stop listening" : "Speak commands"}
          title={listening ? "Stop listening" : "Speak commands (local speech recognition)"}
        >
          {busyMic ? <Loader2 className="spin" size={18} /> : <Mic size={18} />}
        </button>
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
