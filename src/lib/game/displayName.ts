/**
 * Extracts the first word of a display name — used wherever a name is shown
 * inline next to a RollCalculation (RoundReveal.tsx, PlayerTile.tsx, and by
 * extension TieBanner.tsx, which renders through PlayerTile) and a full
 * "first name surname" label would crowd the roll+modifier expression on
 * narrow screens (issue #197).
 *
 * A single-word name (no surname to drop) passes through unchanged. This is
 * for an actual display name only — callers apply the existing
 * `displayName ?? email` fallback themselves and should not run an email
 * address through this.
 */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

/**
 * The `displayName ?? email` fallback plus first-name extraction, combined —
 * every call site needs both, so this folds the "skip extraction for the
 * email fallback" rule in one place rather than each caller re-deriving it
 * around `firstName` (issue #197).
 */
export function firstNameOrFallback(displayName: string | null, fallback: string): string {
  return displayName === null ? fallback : firstName(displayName);
}
