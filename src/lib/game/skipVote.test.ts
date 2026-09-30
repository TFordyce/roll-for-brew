import { describe, expect, it } from "vitest";
import { skipVoteView, type SkipVoteState } from "./skipVote";

const graceEndsAt = new Date("2026-09-30T12:00:30Z");
const before = new Date("2026-09-30T12:00:10Z");
const after = new Date("2026-09-30T12:00:31Z");

function state(overrides: Partial<SkipVoteState>): SkipVoteState {
  return { votes: 0, threshold: 2, hasVoted: false, canVote: true, waitedOn: false, graceEndsAt, ...overrides };
}

describe("skipVoteView", () => {
  it("shows a voter nothing inside the grace period, then the control with the count", () => {
    expect(skipVoteView(state({}), before)).toEqual({ kind: "none" });
    expect(skipVoteView(state({ votes: 1 }), after)).toEqual({ kind: "vote", votes: 1, threshold: 2 });
  });

  it("shows Voted once the viewer has voted", () => {
    expect(skipVoteView(state({ votes: 1, hasVoted: true }), after)).toEqual({ kind: "voted", votes: 1, threshold: 2 });
  });

  it("shows a spectator the count only, after the grace period", () => {
    expect(skipVoteView(state({ canVote: false }), before)).toEqual({ kind: "none" });
    expect(skipVoteView(state({ canVote: false, votes: 1 }), after)).toEqual({ kind: "count", votes: 1, threshold: 2 });
  });

  it("shows a player being waited on no control, and the notice once a vote is in", () => {
    expect(skipVoteView(state({ canVote: false, waitedOn: true }), after)).toEqual({ kind: "none" });
    expect(skipVoteView(state({ canVote: false, waitedOn: true, votes: 1 }), after)).toEqual({ kind: "notice" });
  });
});
