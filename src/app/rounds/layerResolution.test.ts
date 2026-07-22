import { describe, expect, it, vi } from "vitest";
import type { CompletedLayer } from "@/lib/supabase/rolls";
import type { ModifierEffect } from "@/lib/game/modifierBucket";
import { applyLayerOutcome, type ApplyLayerOutcomeDeps } from "./layerResolution";

const supabase = {} as never;

function fakeDeps(overrides: Partial<ApplyLayerOutcomeDeps> = {}): ApplyLayerOutcomeDeps {
  return {
    getRoundRoomId: vi.fn(async () => "room-1"),
    getRoundParticipants: vi.fn(async () =>
      [{ playerId: "p1" }, { playerId: "p2" }, { playerId: "p3" }] as Awaited<
        ReturnType<ApplyLayerOutcomeDeps["getRoundParticipants"]>
      >,
    ),
    getRoundModifierEffects: vi.fn(async () => new Map<string, ModifierEffect[]>()),
    resolveRound: vi.fn(async () => {}),
    advanceRoundLayer: vi.fn(async () => 1),
    broadcastRoundRevealed: vi.fn(async () => {}),
    broadcastLayerTied: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("applyLayerOutcome", () => {
  it("resolves a clear-cut layer: persists the brewer with the round's full participant count and broadcasts the reveal", async () => {
    const deps = fakeDeps();
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 5, modifierSnapshot: 0 },
        { playerId: "p2", value: 12, modifierSnapshot: 0 },
        { playerId: "p3", value: 20, modifierSnapshot: 0 },
      ],
    };

    await applyLayerOutcome(supabase, "round-1", completedLayer, deps);

    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p1", 3);
    expect(deps.broadcastRoundRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      brewerId: "p1",
      cupsMade: 3,
      rolls: [
        { playerId: "p1", value: 5 },
        { playerId: "p2", value: 12 },
        { playerId: "p3", value: 20 },
      ],
    });
    expect(deps.advanceRoundLayer).not.toHaveBeenCalled();
    expect(deps.broadcastLayerTied).not.toHaveBeenCalled();
  });

  it("uses the round's original participant count for cupsMade even when only a narrower tied subset rolled this layer", async () => {
    const deps = fakeDeps({
      getRoundParticipants: vi.fn(async () =>
        [{ playerId: "p1" }, { playerId: "p2" }, { playerId: "p3" }] as Awaited<
          ReturnType<ApplyLayerOutcomeDeps["getRoundParticipants"]>
        >,
      ),
    });
    // Only p1/p2 are in this reroll layer, but the round has 3 participants overall.
    const completedLayer: CompletedLayer = {
      layer: 1,
      rolls: [
        { playerId: "p1", value: 5, modifierSnapshot: 0 },
        { playerId: "p2", value: 12, modifierSnapshot: 0 },
      ],
    };

    await applyLayerOutcome(supabase, "round-1", completedLayer, deps);

    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p1", 3);
  });

  it("resolves a tied layer: advances to the next reroll layer and broadcasts the tie", async () => {
    const deps = fakeDeps();
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 10, modifierSnapshot: 0 },
        { playerId: "p2", value: 10, modifierSnapshot: 0 },
        { playerId: "p3", value: 15, modifierSnapshot: 0 },
      ],
    };

    await applyLayerOutcome(supabase, "round-1", completedLayer, deps);

    expect(deps.advanceRoundLayer).toHaveBeenCalledWith(supabase, "round-1", ["p1", "p2"]);
    expect(deps.broadcastLayerTied).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 1,
      tiedPlayerIds: ["p1", "p2"],
    });
    expect(deps.resolveRound).not.toHaveBeenCalled();
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
    expect(deps.getRoundParticipants).not.toHaveBeenCalled();
  });

  it("resolves a nat-1 outright, ignoring who has the lowest total", async () => {
    const deps = fakeDeps();
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 1, modifierSnapshot: 5 },
        { playerId: "p2", value: 2, modifierSnapshot: 0 },
      ],
    };

    await applyLayerOutcome(supabase, "round-1", completedLayer, deps);

    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p1", 3);
  });

  it("looks up the room via the given roundId before persisting either outcome", async () => {
    const deps = fakeDeps();
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 5, modifierSnapshot: 0 },
        { playerId: "p2", value: 12, modifierSnapshot: 0 },
      ],
    };

    await applyLayerOutcome(supabase, "round-42", completedLayer, deps);

    expect(deps.getRoundRoomId).toHaveBeenCalledWith(supabase, "round-42");
  });

  it("folds an active spell-card modifier effect into the LayerEntry before resolving (issue #67)", async () => {
    const deps = fakeDeps({
      // p2 would win outright on raw roll+modifier (12+0=12 vs p1's 5+0=5),
      // but a +10 flat modifier on p1 flips the outcome to p1.
      getRoundModifierEffects: vi.fn(async () =>
        new Map<string, ModifierEffect[]>([["p1", [{ kind: "flat", delta: 10 }]]]),
      ),
    });
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 5, modifierSnapshot: 0 },
        { playerId: "p2", value: 12, modifierSnapshot: 0 },
      ],
    };

    await applyLayerOutcome(supabase, "round-1", completedLayer, deps);

    // p1's composed total (5 + 10 = 15) now loses to p2's untouched 12, so
    // p2 brews instead of p1 — proof the modifier bucket, not just the raw
    // roll, decided the outcome. cupsMade is 3 (the fake's participant
    // count), unrelated to this layer's 2 rollers.
    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p2", 3);
  });

  it("does not let a spell-card flat modifier mask a nat-1's roll-only precedence", async () => {
    const deps = fakeDeps({
      getRoundModifierEffects: vi.fn(async () =>
        new Map<string, ModifierEffect[]>([["p1", [{ kind: "flat", delta: 999 }]]]),
      ),
    });
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 1, modifierSnapshot: 0 },
        { playerId: "p2", value: 2, modifierSnapshot: 0 },
      ],
    };

    await applyLayerOutcome(supabase, "round-1", completedLayer, deps);

    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p1", 3);
  });
});
