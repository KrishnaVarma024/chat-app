import { useEffect, useRef, useState, type FormEvent } from 'react';

interface MessageInputProps {
  onSend: (body: string) => void;
  disabled?: boolean;
  // Both optional — a caller that doesn't care about typing indicators
  // (there currently isn't one, but nothing here should force every future
  // consumer of this component to wire up typing events it doesn't want)
  // just gets a plain input with no typing side effects at all.
  onTypingStart?: () => void;
  onTypingStop?: () => void;
}

// ARCHITECTURE_V2.md §10's numbers, named rather than left as bare literals
// scattered through the logic below.
const TYPING_START_THROTTLE_MS = 2000; // at most one typing_start per ~2s of active typing
const TYPING_STOP_IDLE_MS = 3000; // explicit typing_stop after ~3s of no further keystrokes

export function MessageInput({ onSend, disabled, onTypingStart, onTypingStop }: MessageInputProps) {
  const [text, setText] = useState('');

  // When onTypingStart was last actually CALLED (not every keystroke) —
  // this is the throttle's own clock, separate from the idle-stop timer
  // below, because "send typing_start at most every 2s" and "send
  // typing_stop after 3s of silence" are two independent clocks, not one
  // timer serving both jobs.
  const lastTypingStartAtRef = useRef(0);
  // The pending "gone quiet" timer — reset on every keystroke, and
  // whichever instance of it actually survives to fire is what emits
  // typing_stop. window.setTimeout's return type (not Node's) because this
  // runs in the browser, never under ts-node/tsx.
  const idleStopTimerRef = useRef<number | null>(null);

  function clearIdleStopTimer() {
    if (idleStopTimerRef.current !== null) {
      window.clearTimeout(idleStopTimerRef.current);
      idleStopTimerRef.current = null;
    }
  }

  // Unmounting (navigating away, or the room switching under this
  // component) must not leave a stray timer trying to call a prop function
  // whose component instance is already gone — React itself won't crash on
  // that (the closure still exists), but it's a pointless emit for a room
  // this user has already left, via leaveRoom's own cleanup.
  useEffect(() => clearIdleStopTimer, []);

  function handleChange(value: string) {
    setText(value);

    if (value.trim().length === 0) {
      // Emptied the box entirely (e.g. selected-all-and-deleted) — stop
      // is unambiguous here, no reason to wait out the idle timer.
      clearIdleStopTimer();
      onTypingStop?.();
      return;
    }

    const now = Date.now();
    if (now - lastTypingStartAtRef.current >= TYPING_START_THROTTLE_MS) {
      lastTypingStartAtRef.current = now;
      onTypingStart?.();
    }

    // Every keystroke pushes the idle-stop deadline back out — this is a
    // debounce (only the LAST call in a burst actually matters), layered
    // on top of the throttle above (which instead guarantees a MINIMUM
    // spacing between calls during a sustained burst). They're solving
    // different problems and neither one substitutes for the other.
    clearIdleStopTimer();
    idleStopTimerRef.current = window.setTimeout(() => {
      idleStopTimerRef.current = null;
      onTypingStop?.();
    }, TYPING_STOP_IDLE_MS);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    clearIdleStopTimer();
    onTypingStop?.();
    onSend(trimmed);
    setText('');
  }

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      <input
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => {
          clearIdleStopTimer();
          onTypingStop?.();
        }}
        placeholder="Type a message…"
        maxLength={4000}
        disabled={disabled}
        autoFocus
      />
      <button type="submit" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}
