import { describe, expect, it, vi } from "vitest";
import type { LayerOutcome } from "@/lib/supabase/roundAdvancement";
import { advanceRound, type AdvanceRoundDeps } from "./advanceRound";

const supabase = {} as never;

/**
 * Advancement behaviour itself is covered against the real SQL functions in
 * tests/integration/round-advancement.test.ts. These pin only what the module
 * owns: which database entry point each event may reach, and which broadcasts
 * each outcome sends.
 */
function fakeDeps(outcome: LayerOutcome): AdvanceRoundDeps {
  return {
    finalizeLayer: vi.fn(async () => outcome),
    getRoundRoomId: vi.fn(async () => "room-1"),
    broadcastRoundRevealed: vi.fn(async () => {}),
    broadcastLayerTied: vi.fn(async () => {}),
    broadcastRoundReplayChanged: vi.fn(async () => {}),
  };
}

const brewer: Extract<LayerOutcome, { outcome: "brewer" }> = {
  outcome: "brewer",
  layer: 0,
  brewerId: "p1",
  cupsMade: 2,
  rolls: [
    { playerId: "p1", value: 3, discardedValue: null, enteredByAdmin: false },
    { playerId: "p2", value: 14, discardedValue: 9, enteredByAdmin: true },
  ],
  replayPending: false,
};

describe("advanceRound", () => {
  it("reactionWindowChanged reaches finalize_layer and no other entry point", async () => {
    const deps = fakeDeps({ outcome: "noop", reason: "window_open" });

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.finalizeLayer).toHaveBeenCalledTimes(1);
    expect(deps.finalizeLayer).toHaveBeenCalledWith(supabase, "round-1");
  });

  it("a brewer outcome broadcasts the round reveal with the final rolls", async () => {
    const deps = fakeDeps(brewer);

    const outcome = await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(outcome).toEqual(brewer);
    expect(deps.broadcastRoundRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 0,
      brewerId: "p1",
      cupsMade: 2,
      rolls: brewer.rolls,
    });
    expect(deps.broadcastRoundReplayChanged).not.toHaveBeenCalled();
    expect(deps.broadcastLayerTied).not.toHaveBeenCalled();
  });

  it("a brewer outcome with a pending Round Replay also broadcasts the replay change", async () => {
    const deps = fakeDeps({ ...brewer, replayPending: true });

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.broadcastRoundRevealed).toHaveBeenCalledTimes(1);
    expect(deps.broadcastRoundReplayChanged).toHaveBeenCalledWith(supabase, "room-1", { roundId: "round-1" });
  });

  it("a tie outcome broadcasts the new Layer and its tied players", async () => {
    const deps = fakeDeps({ outcome: "tie", layer: 1, tiedPlayerIds: ["p1", "p2"] });

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.broadcastLayerTied).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 1,
      tiedPlayerIds: ["p1", "p2"],
    });
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
    expect(deps.broadcastRoundReplayChanged).not.toHaveBeenCalled();
  });

  it("a noop sends no broadcast and skips the room lookup", async () => {
    const deps = fakeDeps({ outcome: "noop", reason: "window_open" });

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.getRoundRoomId).not.toHaveBeenCalled();
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
    expect(deps.broadcastLayerTied).not.toHaveBeenCalled();
    expect(deps.broadcastRoundReplayChanged).not.toHaveBeenCalled();
  });
});
