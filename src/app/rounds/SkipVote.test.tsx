import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkipVoteState } from "@/lib/game/skipVote";

vi.mock("@/app/rounds/actions", () => ({
  voteSkipReactionWindowAction: vi.fn(),
  passReactionWindowAction: vi.fn(),
  castReactionSpellCardAction: vi.fn(),
  spendCourageTokenAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/useRoomChannel", () => ({ useRoomChannel: vi.fn() }));

const { SkipVote } = await import("./SkipVote");
const { ReactionBanner } = await import("./ReactionBanner");

const past = () => new Date(Date.now() - 1_000);
const future = () => new Date(Date.now() + 20_000);

function state(overrides: Partial<SkipVoteState>): SkipVoteState {
  return { votes: 0, threshold: 2, hasVoted: false, canVote: true, waitedOn: false, graceEndsAt: past(), ...overrides };
}

function render(s: SkipVoteState): string {
  return renderToStaticMarkup(<SkipVote roundId="r1" state={s} />);
}

describe("SkipVote (issue #411)", () => {
  it("hides the control inside the grace period", () => {
    expect(render(state({ graceEndsAt: future() }))).toBe("");
  });

  it("offers a voter the Skip waiting control with the count after the grace period", () => {
    const html = render(state({ votes: 1 }));
    expect(html).toContain("Skip waiting");
    expect(html).toContain("1 of 2 votes to skip");
    expect(html).not.toContain("disabled=\"\"");
  });

  it("shows Voted, disabled, once the viewer has voted", () => {
    const html = render(state({ votes: 1, hasVoted: true }));
    expect(html).toContain("Voted");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("Skip waiting");
  });

  it("shows a spectator the count only", () => {
    const html = render(state({ canVote: false, votes: 1 }));
    expect(html).toContain("1 of 2 votes to skip");
    expect(html).not.toContain("<button");
  });

  it("shows a player being waited on the notice once a vote is in, never the control", () => {
    expect(render(state({ canVote: false, waitedOn: true }))).toBe("");
    const html = render(state({ canVote: false, waitedOn: true, votes: 1 }));
    expect(html).toContain("The table is voting to skip. Pass or react now.");
    expect(html).not.toContain("Skip waiting");
  });
});

describe("ReactionBanner with a Skip vote (issue #411)", () => {
  const base = {
    roomId: "room",
    roundId: "r1",
    selfPlayerId: "me",
    heldReactionCard: null,
    stack: [],
    participants: [],
  };

  it("a player who already passed sees the waiting line and the Skip waiting control", () => {
    const html = renderToStaticMarkup(
      <ReactionBanner
        {...base}
        eligible
        alreadyPassed
        pendingPlayers={[{ playerId: "ada", displayName: "Ada" }]}
        skipVote={state({ votes: 0, threshold: 1 })}
      />,
    );
    expect(html).toContain("Waiting on Ada…");
    expect(html).toContain("Skip waiting");
    expect(html).toContain("0 of 1 votes to skip");
  });

  it("the player being waited on sees Pass and the notice, not the control", () => {
    const html = renderToStaticMarkup(
      <ReactionBanner
        {...base}
        eligible
        alreadyPassed={false}
        pendingPlayers={[{ playerId: "me", displayName: "Me" }]}
        skipVote={state({ votes: 1, canVote: false, waitedOn: true })}
      />,
    );
    expect(html).toContain("Pass");
    expect(html).toContain("The table is voting to skip. Pass or react now.");
    expect(html).not.toContain("Skip waiting");
  });
});

describe("ReactionBanner with a Courage Token (issue #439)", () => {
  const base = {
    roomId: "room",
    roundId: "r1",
    selfPlayerId: "me",
    heldReactionCard: null,
    stack: [],
    participants: [],
    pendingPlayers: [],
    skipVote: null,
  };
  const token = { effectId: "e1", giverPlayerId: "ada", giverDisplayName: "Ada", dice: "1d6" };

  it("prompts a token holder with no Reaction card to spend it, or pass", () => {
    const html = renderToStaticMarkup(
      <ReactionBanner {...base} eligible alreadyPassed={false} courageTokens={[token]} />,
    );
    expect(html).toContain("Courage Token</strong> from Ada");
    expect(html).toContain("Add d6");
    expect(html).toContain("Pass");
    expect(html).not.toContain("React with");
  });

  it("counts several tokens and offers the oldest", () => {
    const html = renderToStaticMarkup(
      <ReactionBanner
        {...base}
        eligible
        alreadyPassed={false}
        courageTokens={[token, { ...token, effectId: "e2", giverPlayerId: "ben", giverDisplayName: "Ben" }]}
      />,
    );
    expect(html).toContain("from Ada (2 held)");
  });

  it("offers nothing once the holder has passed", () => {
    const html = renderToStaticMarkup(<ReactionBanner {...base} eligible alreadyPassed courageTokens={[token]} />);
    expect(html).not.toContain("Courage Token");
  });
});
