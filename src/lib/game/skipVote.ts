/**
 * How long after a poll round starts the table may vote to skip the players
 * being waited on. vote_skip_reaction_window (0114) enforces the same 30
 * seconds server-side.
 */
export const SKIP_VOTE_GRACE_MS = 30 * 1000;

/**
 * What the reaction banner shows for the Skip vote (issue #411), from the
 * viewer's side:
 *  - `vote`: a voter after the grace period who hasn't voted — the
 *    "Skip waiting" control with the count.
 *  - `voted`: a voter who has voted — "Voted" with the count.
 *  - `count`: a spectator (or a stall-excluded participant) after the grace
 *    period — the count only.
 *  - `notice`: a player being waited on once at least one vote is in — "pass
 *    or react now".
 *  - `none`: nothing yet (inside the grace period, or nobody has voted on a
 *    player being waited on).
 */
export type SkipVoteView =
  | { kind: "vote" | "voted" | "count"; votes: number; threshold: number }
  | { kind: "notice" }
  | { kind: "none" };

export type SkipVoteState = {
  votes: number;
  threshold: number;
  hasVoted: boolean;
  canVote: boolean;
  waitedOn: boolean;
  /** When voting opens: 30 seconds after the current poll round started. */
  graceEndsAt: Date;
};

export function skipVoteView(state: SkipVoteState, now: Date): SkipVoteView {
  const { votes, threshold } = state;
  if (state.waitedOn) return votes > 0 ? { kind: "notice" } : { kind: "none" };
  if (state.hasVoted) return { kind: "voted", votes, threshold };
  if (now < state.graceEndsAt) return { kind: "none" };
  return { kind: state.canVote ? "vote" : "count", votes, threshold };
}
