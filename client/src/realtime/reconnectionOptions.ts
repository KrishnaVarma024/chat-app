/**
 * The client's reconnection policy as DATA, not scattered literals —
 * ARCHITECTURE_V2.md §6. Lives in its own dependency-free module so the
 * exact numbers the app ships with can be fed to a real Socket.IO Manager in
 * a test (reconnectionOptions.test.ts) and asserted on, instead of the test
 * re-typing numbers that could silently drift from the code.
 *
 * Exponential backoff (delay doubles each failed attempt) with jitter, capped:
 *   attempt n waits  min(1000 * 2^n, 30000)  ±50%
 *
 * Why each knob is what it is:
 *  - delay 1000: fast enough that a blip feels instant, slow enough that a
 *    server that is genuinely down isn't hit hundreds of times a second.
 *  - delayMax 30000: after a few failures stop doubling; waiting minutes to
 *    notice the server came back would feel broken.
 *  - randomizationFactor 0.5: THE important one. When a server restarts,
 *    every client lost its connection at the same instant. Without jitter
 *    they all retry at exactly t=1s, then t=3s, then t=7s... a synchronized
 *    stampede (a "thundering herd") that can knock the fresh instance over
 *    again. ±50% spreads the retries across a window.
 *  - attempts Infinity: a chat app that gives up after N tries forces the
 *    user to refresh the page to get back.
 */
export const RECONNECTION_OPTIONS = {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 30000,
  randomizationFactor: 0.5,
  reconnectionAttempts: Infinity,
} as const;
