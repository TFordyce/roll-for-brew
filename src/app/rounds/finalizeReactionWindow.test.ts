import { describe, expect, it, vi } from "vitest";
import type { CompletedLayer } from "@/lib/supabase/rolls";
import { finalizeReactionWindow, type FinalizeReactionWindowDeps } from "./layerResolution";

const supabase = {} as never;

function fakeDeps(overrides: Partial<FinalizeReactionWindowDeps> = {}): FinalizeReactionWindowDeps {
  return {
    getCurrentLayerRollsIfComplete: vi.fn(async () => null),
    getForcedRerollTargets: vi.fn(async () => []),
    applyForcedReroll: vi.fn(async () => 20),
    applyLayerOutcome: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("finalizeReactionWindow", () => {
  it("does nothing if the layer isn't complete", async () => {
    const deps = fakeDeps();

    await finalizeReactionWindow(supabase, "round-1", deps);

    expect(deps.applyLayerOutcome).not.toHaveBeenCalled();
  });

  it("passes the completed layer straight through to applyLayerOutcome when there's no forced reroll", async () => {
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 5, modifierSnapshot: 0 },
        { playerId: "p2", value: 12, modifierSnapshot: 0 },
      ],
    };
    const deps = fakeDeps({
      getCurrentLayerRollsIfComplete: vi.fn(async () => completedLayer),
    });

    await finalizeReactionWindow(supabase, "round-1", deps);

    expect(deps.applyForcedReroll).not.toHaveBeenCalled();
    expect(deps.applyLayerOutcome).toHaveBeenCalledWith(supabase, "round-1", completedLayer);
  });

  it("replaces a forced-reroll target's roll in place before calling applyLayerOutcome (issue #68)", async () => {
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 2, modifierSnapshot: 0 },
        { playerId: "p2", value: 12, modifierSnapshot: 0 },
      ],
    };
    const deps = fakeDeps({
      getCurrentLayerRollsIfComplete: vi.fn(async () => completedLayer),
      getForcedRerollTargets: vi.fn(async () => ["p1"]),
      applyForcedReroll: vi.fn(async () => 19),
    });

    await finalizeReactionWindow(supabase, "round-1", deps);

    expect(deps.applyForcedReroll).toHaveBeenCalledWith(supabase, "round-1", 0, "p1");
    expect(deps.applyLayerOutcome).toHaveBeenCalledWith(supabase, "round-1", {
      layer: 0,
      rolls: [
        { playerId: "p1", value: 19, modifierSnapshot: 0 },
        { playerId: "p2", value: 12, modifierSnapshot: 0 },
      ],
    });
  });

  it("applies a forced reroll for every distinct target when multiple are active", async () => {
    const completedLayer: CompletedLayer = {
      layer: 1,
      rolls: [
        { playerId: "p1", value: 2, modifierSnapshot: 0 },
        { playerId: "p2", value: 3, modifierSnapshot: 0 },
        { playerId: "p3", value: 12, modifierSnapshot: 0 },
      ],
    };
    const newValues: Record<string, number> = { p1: 18, p2: 4 };
    const deps = fakeDeps({
      getCurrentLayerRollsIfComplete: vi.fn(async () => completedLayer),
      getForcedRerollTargets: vi.fn(async () => ["p1", "p2"]),
      applyForcedReroll: vi.fn(async (_s, _r, _l, playerId: string) => newValues[playerId] as number),
    });

    await finalizeReactionWindow(supabase, "round-1", deps);

    expect(deps.applyLayerOutcome).toHaveBeenCalledWith(supabase, "round-1", {
      layer: 1,
      rolls: [
        { playerId: "p1", value: 18, modifierSnapshot: 0 },
        { playerId: "p2", value: 4, modifierSnapshot: 0 },
        { playerId: "p3", value: 12, modifierSnapshot: 0 },
      ],
    });
  });
});
