/**
 * Pure poll-close and LIFO-ordering rules for the reaction window (issue
 * #68), mirroring stallTimeout.ts's style: no Supabase/network dependency,
 * deterministic on its inputs. The SQL RPCs (cast_reaction_spell_card,
 * pass_reaction_window in supabase/migrations/0020_spell_reaction_window.sql)
 * are the source of truth in production — this module exists so the
 * "closes only once every eligible holder has passed in the same poll
 * round" and "resolves LIFO" rules have their own focused, fast tests
 * independent of a live database.
 */

/**
 * True once every currently-eligible player id appears in the passed set for
 * the window's current poll round. Eligibility and passes are both taken as
 * of "right now" — a player who stops being eligible (casts their card, or
 * loses it some other way) drops out of the set this checks against, which
 * is why casting reopens the poll rather than needing to touch every other
 * player's prior pass: it's the eligible set recomputing, not the passes
 * being invalidated.
 */
export function isReactionWindowClosed(eligiblePlayerIds: string[], passedPlayerIds: string[]): boolean {
  const passed = new Set(passedPlayerIds);
  return eligiblePlayerIds.every((id) => passed.has(id));
}

export type ReactionStackEntry = {
  castId: string;
  seq: number;
  parentCastId: string | null;
};

/**
 * Orders a reaction window's casts LIFO (last cast, first resolved) by their
 * strict cast sequence — highest seq first. Used for display (the stack, top
 * entry first) and to confirm the resolution order a caller intends to walk
 * matches the spec's "last cast, first resolved" rule.
 */
export function orderStackForResolution<T extends ReactionStackEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.seq - a.seq);
}
