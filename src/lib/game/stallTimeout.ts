/**
 * Fixed stall-timeout duration (issue #21) — not user/room-configurable.
 * Enforced at three points: an open round whose starter never closes
 * declarations, a declared player who never submits a roll, and a tied
 * player who never submits a tie-break reroll.
 */
export const STALL_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Whether at least STALL_TIMEOUT_MS has elapsed between `since` and `now`.
 * `now` is a plain parameter (never `new Date()` computed in here) so
 * callers — and their tests — can simulate elapsed time without sleeping
 * out the real ~2-minute timeout.
 */
export function hasStalled(since: string, now: Date): boolean {
  return now.getTime() - new Date(since).getTime() >= STALL_TIMEOUT_MS;
}
