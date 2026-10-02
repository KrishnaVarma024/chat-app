import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTypingTracker } from './typingTracker';

const AUTO_CLEAR_MS = 5000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('typingTracker', () => {
  it('markTyping adds the user and notifies with a Set containing them', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markTyping(1);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(new Set([1]));
  });

  it('a second markTyping for the SAME user before they clear does not re-notify (already present)', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markTyping(1);
    tracker.markTyping(1);

    expect(onChange).toHaveBeenCalledTimes(1); // only the first call changed membership
  });

  it('markStopped removes the user immediately, not waiting for the auto-clear timer', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markTyping(1);
    tracker.markStopped(1);

    expect(onChange).toHaveBeenLastCalledWith(new Set());
    // Advancing time should NOT produce a third call — the timer was
    // cancelled, not just raced.
    const callsBeforeAdvance = onChange.mock.calls.length;
    vi.advanceTimersByTime(AUTO_CLEAR_MS + 100);
    expect(onChange).toHaveBeenCalledTimes(callsBeforeAdvance);
  });

  it('markStopped for a user who was never typing is a harmless no-op', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markStopped(999);

    expect(onChange).not.toHaveBeenCalled();
  });

  // This IS the Phase 14 DoD, in isolation: a sender that goes silent
  // (crashes, loses connection) without ever emitting typing_stop must
  // still have their indicator clear on its own.
  it('a user who never gets a stopped_typing event auto-clears after autoClearMs', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markTyping(1);
    vi.advanceTimersByTime(AUTO_CLEAR_MS - 1);
    expect(onChange).toHaveBeenLastCalledWith(new Set([1])); // still typing, 1ms early

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(new Set()); // now cleared
  });

  // The throttled sender re-emits typing_start roughly every 2s while
  // actively typing — this proves a sustained burst of markTyping calls,
  // each arriving before the previous timer would have fired, keeps the
  // indicator alive continuously rather than flickering off every
  // autoClearMs.
  it('repeated markTyping calls before the timer fires keep resetting the clock — no premature clear', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markTyping(1);
    vi.advanceTimersByTime(3000);
    tracker.markTyping(1); // re-typed at t=3000, resets the 5s clock
    vi.advanceTimersByTime(3000); // t=6000 total, but only 3000ms since the reset
    expect(onChange).toHaveBeenLastCalledWith(new Set([1])); // still typing

    vi.advanceTimersByTime(2000); // t=8000, 5000ms since the reset at t=3000
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });

  it('tracks multiple users independently — one clearing does not affect the other', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markTyping(1);
    vi.advanceTimersByTime(2000);
    tracker.markTyping(2);

    tracker.markStopped(1);
    expect(onChange).toHaveBeenLastCalledWith(new Set([2]));

    vi.advanceTimersByTime(AUTO_CLEAR_MS);
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });

  it('reset() clears every pending timer and every tracked user in one notification', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.markTyping(1);
    tracker.markTyping(2);
    onChange.mockClear();

    tracker.reset();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(new Set());

    // No stray timers survived reset() to fire later and re-add anyone.
    vi.advanceTimersByTime(AUTO_CLEAR_MS + 100);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reset() on an already-empty tracker does not notify at all', () => {
    const onChange = vi.fn();
    const tracker = createTypingTracker(onChange, AUTO_CLEAR_MS);

    tracker.reset();

    expect(onChange).not.toHaveBeenCalled();
  });
});
