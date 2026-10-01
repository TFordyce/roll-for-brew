import { describe, expect, it, vi } from "vitest";
import type { LayerOutcome } from "@/lib/supabase/roundAdvancement";
import { advanceRound, type AdvanceRoundDeps, type AdvanceRoundEvent } from "./advanceRound";

const supabase = {} as never;

/**
 * Advancement behaviour itself is covered against the real SQL functions in
 * tests/integration/round-advancement.test.ts. These pin only what the module
 * owns: which database entry point each event may reach, and which broadcasts
 * each outcome sends.
 */
function fakeDeps(outcome: LayerOutcome): AdvanceRoundDeps {
  return {
    advanceLayer: vi.fn(async () => outcome),
    finalizeLayer: vi.fn(async () => outcome),
    getRoundRoomId: vi.fn(async () => "room-1"),
    broadcastLayerRollsRevealed: vi.fn(async () => {}),
    broadcastRoundRevealed: vi.fn(async () => {}),
    broadcastLayerTied: vi.fn(async () => {}),
    broadcastRoundReplayChanged: vi.fn(async () => {}),
    broadcastSpellCastChanged: vi.fn(async () => {}),
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

const rawRolls = [
  { playerId: "p1", value: 17, discardedValue: null, enteredByAdmin: false },
  { playerId: "p2", value: 6, discardedValue: null, enteredByAdmin: false },
];

const noop: LayerOutcome = { outcome: "noop", reason: "window_open" };

describe("advanceRound", () => {
  it("reactionWindowChanged reaches finalize_layer and never advance_layer", async () => {
    const deps = fakeDeps(noop);

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.finalizeLayer).toHaveBeenCalledTimes(1);
    expect(deps.finalizeLayer).toHaveBeenCalledWith(supabase, "round-1");
    expect(deps.advanceLayer).not.toHaveBeenCalled();
  });

  it.each<AdvanceRoundEvent>([
    "layerRolled",
    "pendingDieResolved",
    "deferredTargetSet",
    "revoltPickMade",
    "stallCleared",
    "roundClosed",
    "lateDeclared",
  ])(
    "%s reaches advance_layer and never finalize_layer directly",
    async (event) => {
      const deps = fakeDeps(noop);

      await advanceRound(supabase, "round-1", event, deps);

      expect(deps.advanceLayer).toHaveBeenCalledTimes(1);
      expect(deps.advanceLayer).toHaveBeenCalledWith(supabase, "round-1");
      expect(deps.finalizeLayer).not.toHaveBeenCalled();
    },
  );

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
    expect(deps.broadcastLayerRollsRevealed).not.toHaveBeenCalled();
  });

  it("roundClosed resolving a debt round broadcasts the reveal with no rolls", async () => {
    // Issue #432: a debt round resolves at close -- advance_layer finalizes it
    // with no window and no layer_rolls, and the Debtor is the Tea Maker.
    const debtRound: LayerOutcome = { ...brewer, brewerId: "p2", rolls: [] };
    const deps = fakeDeps(debtRound);

    await advanceRound(supabase, "round-1", "roundClosed", deps);

    expect(deps.advanceLayer).toHaveBeenCalledWith(supabase, "round-1");
    expect(deps.broadcastRoundRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 0,
      brewerId: "p2",
      cupsMade: 2,
      rolls: [],
    });
    expect(deps.broadcastLayerRollsRevealed).not.toHaveBeenCalled();
  });

  it("a brewer outcome with a pending Round Replay also broadcasts the replay change", async () => {
    const deps = fakeDeps({ ...brewer, replayPending: true });

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.broadcastRoundRevealed).toHaveBeenCalledTimes(1);
    expect(deps.broadcastRoundReplayChanged).toHaveBeenCalledWith(supabase, "room-1", { roundId: "round-1" });
  });

  it("a tie outcome broadcasts the new Layer and its tied players", async () => {
    const deps = fakeDeps({ outcome: "tie", layer: 1, tiedPlayerIds: ["p1", "p2"], rolloff: false });

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.broadcastLayerTied).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 1,
      tiedPlayerIds: ["p1", "p2"],
    });
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
    expect(deps.broadcastRoundReplayChanged).not.toHaveBeenCalled();
  });

  it("a Loose Leaf roll-off outcome sends the tied broadcast, so the tie modal runs the roll-off", async () => {
    const deps = fakeDeps({ outcome: "tie", layer: 1, tiedPlayerIds: ["p1", "p3"], rolloff: true });

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.broadcastLayerTied).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 1,
      tiedPlayerIds: ["p1", "p3"],
    });
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
  });

  it("a noop sends no broadcast and skips the room lookup", async () => {
    const deps = fakeDeps(noop);

    await advanceRound(supabase, "round-1", "reactionWindowChanged", deps);

    expect(deps.getRoundRoomId).not.toHaveBeenCalled();
    expect(deps.broadcastLayerRollsRevealed).not.toHaveBeenCalled();
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
    expect(deps.broadcastLayerTied).not.toHaveBeenCalled();
    expect(deps.broadcastRoundReplayChanged).not.toHaveBeenCalled();
    expect(deps.broadcastSpellCastChanged).not.toHaveBeenCalled();
  });

  it("a Layer held for a Tea Party Revolt pick broadcasts a spell-cast change, so the picker sees the prompt", async () => {
    const deps = fakeDeps({ outcome: "noop", reason: "revolt_pick_pending" });

    await advanceRound(supabase, "round-1", "layerRolled", deps);

    expect(deps.broadcastSpellCastChanged).toHaveBeenCalledWith(supabase, "room-1", { roundId: "round-1" });
    expect(deps.broadcastLayerRollsRevealed).not.toHaveBeenCalled();
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
  });

  it("first completion broadcasts the layer rolls revealed, even when the window stays open", async () => {
    const deps = fakeDeps({
      outcome: "windowOpened",
      layer: 0,
      windowClosed: false,
      finalization: null,
      layerRolls: { layer: 0, rolls: rawRolls },
    });

    await advanceRound(supabase, "round-1", "layerRolled", deps);

    expect(deps.getRoundRoomId).toHaveBeenCalledTimes(1);
    expect(deps.broadcastLayerRollsRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 0,
      rolls: rawRolls,
    });
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
    expect(deps.broadcastLayerTied).not.toHaveBeenCalled();
  });

  it("a window that closed on the spot broadcasts the rolls, then its finalization outcome", async () => {
    const deps = fakeDeps({
      outcome: "windowOpened",
      layer: 0,
      windowClosed: true,
      finalization: { ...brewer, replayPending: true },
      layerRolls: { layer: 0, rolls: rawRolls },
    });

    await advanceRound(supabase, "round-1", "layerRolled", deps);

    expect(deps.getRoundRoomId).toHaveBeenCalledTimes(1);
    expect(deps.broadcastLayerRollsRevealed).toHaveBeenCalledTimes(1);
    expect(deps.broadcastRoundRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 0,
      brewerId: "p1",
      cupsMade: 2,
      rolls: brewer.rolls,
    });
    expect(deps.broadcastRoundReplayChanged).toHaveBeenCalledTimes(1);
  });

  it("a Tie-Break Reroll Layer's first completion broadcasts its rolls and the outcome", async () => {
    const deps = fakeDeps({
      outcome: "tie",
      layer: 2,
      tiedPlayerIds: ["p1", "p2"],
      rolloff: false,
      layerRolls: { layer: 1, rolls: rawRolls },
    });

    await advanceRound(supabase, "round-1", "layerRolled", deps);

    expect(deps.broadcastLayerRollsRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 1,
      rolls: rawRolls,
    });
    expect(deps.broadcastLayerTied).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 2,
      tiedPlayerIds: ["p1", "p2"],
    });
  });
});
