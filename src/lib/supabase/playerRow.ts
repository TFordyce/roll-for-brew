/**
 * Supabase's PostgREST client types a joined-to-one relationship as
 * `T | T[]` depending on the query shape, even though it's always a single
 * row for a foreign-key join. Unwraps that to the single row (or null).
 */
export function unwrapJoinedPlayer<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
