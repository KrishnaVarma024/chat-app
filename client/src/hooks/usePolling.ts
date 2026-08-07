import { useEffect, useRef } from 'react';

interface UsePollingOptions {
  /** Interval used right after new data arrives (or on resume from hidden). */
  baseIntervalMs: number;
  /** Interval never grows past this, however long the room stays quiet. */
  maxIntervalMs: number;
  /** How fast the interval grows on each consecutive empty poll. */
  backoffMultiplier?: number;
  /** Runs one poll; return true if it returned new data, false if it didn't. */
  onPoll: () => Promise<boolean>;
  enabled: boolean;
}

/**
 * A single recursive setTimeout loop (not setInterval — setInterval would
 * keep firing even while a slow request from the previous tick is still
 * in flight, letting requests pile up; scheduling the *next* call only
 * after the current one resolves can't do that).
 *
 * Three behaviors, each earning its keep:
 *  - Backoff: an empty room shouldn't poll every 2s forever. Every empty
 *    response grows the interval (up to a cap); any response with new
 *    data snaps it back to baseIntervalMs immediately — a room shouldn't
 *    feel laggy right after it becomes active again.
 *  - Page Visibility pause: a backgrounded tab stops polling entirely
 *    instead of burning requests (and rate-limit budget) for a screen
 *    nobody's looking at.
 *  - Resume-and-catch-up: coming back to a visible tab resets to the base
 *    interval and polls immediately, rather than waiting out whatever
 *    backed-off interval was active when it was hidden.
 */
export function usePolling({
  baseIntervalMs,
  maxIntervalMs,
  backoffMultiplier = 2,
  onPoll,
  enabled,
}: UsePollingOptions): void {
  // Ref so the effect's long-lived closure always calls the LATEST onPoll
  // (which closes over current cursor/room state) without needing to tear
  // down and rebuild the whole timer loop every time that state changes.
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: number | undefined;
    let currentInterval = baseIntervalMs;

    async function tick() {
      if (cancelled || document.hidden) return;
      try {
        const gotNewData = await onPollRef.current();
        currentInterval = gotNewData
          ? baseIntervalMs
          : Math.min(currentInterval * backoffMultiplier, maxIntervalMs);
      } catch {
        // Transient network error — hold the current interval rather than
        // letting a single failed request spike the backoff.
      }
      if (!cancelled && !document.hidden) {
        timer = window.setTimeout(tick, currentInterval);
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer);
      } else {
        currentInterval = baseIntervalMs;
        tick();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!document.hidden) tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, baseIntervalMs, maxIntervalMs, backoffMultiplier]);
}
