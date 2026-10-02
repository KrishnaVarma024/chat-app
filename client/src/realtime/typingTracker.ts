/**
 * The "who's currently typing, with a per-user auto-clear safety net"
 * state machine (ARCHITECTURE_V2.md §10), pulled out of ChatRoomPage into
 * its own framework-free module — same reasoning as Phase 11's
 * outbox.ts: this logic is pure bookkeeping around timers and a Set, it
 * has nothing to do with React, and leaving it as inline closures inside
 * a useEffect would mean the only way to test the auto-clear guarantee
 * (the actual DoD for this phase) is driving a full mounted component
 * through fake timers. A plain module can be driven directly and
 * deterministically — see typingTracker.test.ts — with React reduced to
 * "call markTyping/markStopped when an event arrives, render whatever
 * onChange hands back."
 */
export function createTypingTracker(onChange: (typingUserIds: Set<number>) => void, autoClearMs: number) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let current = new Set<number>();

  function notify() {
    // A fresh Set, not the mutated one — callers (React state setters)
    // need a new reference to know something changed.
    onChange(new Set(current));
  }

  function clearTimer(userId: number) {
    const existing = timers.get(userId);
    if (existing !== undefined) {
      clearTimeout(existing);
      timers.delete(userId);
    }
  }

  /**
   * Call on every 'typing' event for this user. Restarts their auto-clear
   * clock EVERY time, not just on the first call — this is what keeps a
   * sustained typing burst (the sender throttles typing_start to about
   * once per 2s; see MessageInput.tsx) showing continuously instead of
   * flickering off every `autoClearMs` while they're still actively
   * typing.
   */
  function markTyping(userId: number): void {
    clearTimer(userId);
    if (!current.has(userId)) {
      current.add(userId);
      notify();
    }
    timers.set(
      userId,
      setTimeout(() => {
        timers.delete(userId);
        if (current.delete(userId)) notify();
      }, autoClearMs)
    );
  }

  /** Call on an explicit 'stopped_typing' event. Immediate — no reason to
   * wait out the safety-net timer when the sender told you directly. */
  function markStopped(userId: number): void {
    clearTimer(userId);
    if (current.delete(userId)) notify();
  }

  /** Call when leaving the room entirely (switching rooms, unmounting) —
   * drops every pending timer and clears all tracked users in one shot,
   * rather than leaving stale timers running for a room no longer being
   * displayed. */
  function reset(): void {
    for (const timerId of timers.values()) clearTimeout(timerId);
    timers.clear();
    if (current.size > 0) {
      current = new Set();
      notify();
    }
  }

  return { markTyping, markStopped, reset };
}

export type TypingTracker = ReturnType<typeof createTypingTracker>;
