import { describe, expect, it, vi } from "vitest";
import type { CompletedLayer } from "@/lib/supabase/rolls";
import { resolveCompletedLayerIfAny, type ResolveCompletedLayerDeps } from "./layerResolution";

const supabase = {} as never;

function fakeDeps(overrides: Partial<ResolveCompletedLayerDeps> = {}): ResolveCompletedLayerDeps {
  return {
    getCurrentLayerRollsIfComplete: vi.fn(async () => null),
    getRoundRoomId: vi.fn(async () => "room-1"),
    broadcastLayerRollsRevealed: vi.fn(async () => {}),
    openReactionWindow: vi.fn(async () => ({ windowId: "window-1", isClosed: true })),
    finalizeReactionWindow: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("resolveCompletedLayerIfAny", () => {
  it("does nothing if the current layer isn't complete", async () => {
    const deps = fakeDeps();

    await resolveCompletedLayerIfAny(supabase, "round-1", deps);

    expect(deps.broadcastLayerRollsRevealed).not.toHaveBeenCalled();
    expect(deps.openReactionWindow).not.toHaveBeenCalled();
    expect(deps.finalizeReactionWindow).not.toHaveBeenCalled();
  });

  it("opens a reaction window for a completed layer-0 (original roll) and finalizes immediately once it self-closes", async () => {
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [{ playerId: "p1", value: 12, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false }],
    };
    const deps = fakeDeps({
      getCurrentLayerRollsIfComplete: vi.fn(async () => completedLayer),
      openReactionWindow: vi.fn(async () => ({ windowId: "window-1", isClosed: true })),
    });

    await resolveCompletedLayerIfAny(supabase, "round-1", deps);

    expect(deps.openReactionWindow).toHaveBeenCalledWith(supabase, "round-1", 0);
    expect(deps.finalizeReactionWindow).toHaveBeenCalledWith(supabase, "round-1");
  });

  it("leaves finalization to the later reaction/pass action when a layer-0 window stays open", async () => {
    const completedLayer: CompletedLayer = {
      layer: 0,
      rolls: [{ playerId: "p1", value: 12, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false }],
    };
    const deps = fakeDeps({
      getCurrentLayerRollsIfComplete: vi.fn(async () => completedLayer),
      openReactionWindow: vi.fn(async () => ({ windowId: "window-1", isClosed: false })),
    });

    await resolveCompletedLayerIfAny(supabase, "round-1", deps);

    expect(deps.finalizeReactionWindow).not.toHaveBeenCalled();
  });

  it("never opens a reaction window for a tie-break reroll layer, and finalizes it immediately instead (issue #219)", async () => {
    const completedLayer: CompletedLayer = {
      layer: 1,
      rolls: [
        { playerId: "p1", value: 12, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false },
        { playerId: "p2", value: 12, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false },
      ],
    };
    const deps = fakeDeps({
      getCurrentLayerRollsIfComplete: vi.fn(async () => completedLayer),
    });

    await resolveCompletedLayerIfAny(supabase, "round-1", deps);

    expect(deps.openReactionWindow).not.toHaveBeenCalled();
    expect(deps.finalizeReactionWindow).toHaveBeenCalledWith(supabase, "round-1");
  });

  it("still broadcasts the raw rolls for a tie-break reroll layer before finalizing", async () => {
    const completedLayer: CompletedLayer = {
      layer: 2,
      rolls: [{ playerId: "p1", value: 7, modifierSnapshot: 0, discardedValue: 3, enteredByAdmin: false }],
    };
    const deps = fakeDeps({
      getCurrentLayerRollsIfComplete: vi.fn(async () => completedLayer),
    });

    await resolveCompletedLayerIfAny(supabase, "round-1", deps);

    expect(deps.broadcastLayerRollsRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 2,
      rolls: [{ playerId: "p1", value: 7, discardedValue: 3, enteredByAdmin: false }],
    });
  });
});
