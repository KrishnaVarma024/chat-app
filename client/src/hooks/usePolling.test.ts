import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePolling } from './usePolling';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls at the base interval while data keeps arriving', async () => {
    const onPoll = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      usePolling({ baseIntervalMs: 1000, maxIntervalMs: 4000, onPoll, enabled: true })
    );

    // Fires once immediately on mount.
    expect(onPoll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onPoll).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially on empty polls, capped at maxIntervalMs', async () => {
    const onPoll = vi.fn().mockResolvedValue(false); // never any new data
    renderHook(() =>
      usePolling({ baseIntervalMs: 1000, maxIntervalMs: 4000, backoffMultiplier: 2, onPoll, enabled: true })
    );

    // Backoff is computed right after EVERY poll, including the very first
    // one — so the gap before call #2 is already the doubled interval
    // (2000ms), not the base (1000ms). Timeline for base=1000, x2, cap=4000:
    // t=0 (call 1) -> +2000 -> t=2000 (call 2) -> +4000 -> t=6000 (call 3,
    // now capped) -> +4000 -> t=10000 (call 4, still capped).
    expect(onPoll).toHaveBeenCalledTimes(1); // t=0

    await vi.advanceTimersByTimeAsync(1999); // just before t=2000
    expect(onPoll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=2000
    expect(onPoll).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3999); // just before t=6000
    expect(onPoll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // t=6000 -> interval now capped at 4000
    expect(onPoll).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(3999); // just before t=10000
    expect(onPoll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); // t=10000 -> stays capped at 4000
    expect(onPoll).toHaveBeenCalledTimes(4);
  });

  it('resets to the base interval as soon as new data arrives again', async () => {
    let returnsData = false;
    const onPoll = vi.fn().mockImplementation(async () => returnsData);
    renderHook(() =>
      usePolling({ baseIntervalMs: 1000, maxIntervalMs: 8000, backoffMultiplier: 2, onPoll, enabled: true })
    );

    expect(onPoll).toHaveBeenCalledTimes(1); // t=0, empty -> next interval 2000
    await vi.advanceTimersByTimeAsync(2000); // t=2000
    expect(onPoll).toHaveBeenCalledTimes(2); // empty -> next interval 4000

    returnsData = true;
    await vi.advanceTimersByTimeAsync(4000); // t=6000, this poll returns true -> resets to base (1000)
    expect(onPoll).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1000); // t=7000 -> back at base interval, not the backed-off one
    expect(onPoll).toHaveBeenCalledTimes(4);
  });

  it('stops polling while the tab is hidden, and catches up immediately on resume', async () => {
    const onPoll = vi.fn().mockResolvedValue(false);
    renderHook(() =>
      usePolling({ baseIntervalMs: 1000, maxIntervalMs: 4000, onPoll, enabled: true })
    );
    expect(onPoll).toHaveBeenCalledTimes(1);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(10000); // however long, nothing should fire while hidden
    expect(onPoll).toHaveBeenCalledTimes(1);

    setHidden(false); // resume -> immediate poll, not a wait for the next interval
    await vi.advanceTimersByTimeAsync(0);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('does nothing at all when disabled', async () => {
    const onPoll = vi.fn().mockResolvedValue(true);
    renderHook(() => usePolling({ baseIntervalMs: 1000, maxIntervalMs: 4000, onPoll, enabled: false }));

    await vi.advanceTimersByTimeAsync(10000);
    expect(onPoll).not.toHaveBeenCalled();
  });
});
