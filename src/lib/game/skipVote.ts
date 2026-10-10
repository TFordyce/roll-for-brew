export const SKIP_VOTE_GRACE_MS = 30 * 1000;

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
  graceEndsAt: Date;
};

export function skipVoteView(state: SkipVoteState, now: Date): SkipVoteView {
  const { votes, threshold } = state;
  if (state.waitedOn) return votes > 0 ? { kind: "notice" } : { kind: "none" };
  if (state.hasVoted) return { kind: "voted", votes, threshold };
  if (now < state.graceEndsAt) return { kind: "none" };
  return { kind: state.canVote ? "vote" : "count", votes, threshold };
}
