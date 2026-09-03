import { describe, expect, it, vi } from "vitest";
import type { CompletedLayer, ResolveRoundOutcome } from "@/lib/supabase/rolls";
import { applyLayerOutcome, type ApplyLayerOutcomeDeps } from "./layerResolution";

const supabase = {} as never;

/**
 * The outcome math itself lives in the authoritative SQL resolve_round(uuid)
 * and is covered by tests/integration/resolve-round.test.ts. These unit
 * tests pin only what applyLayerOutcome still owns: the persistence and
 * broadcast wiring around whichever outcome the resolver returns.
 */
function fakeDeps(overrides: Partial<ApplyLayerOutcomeDeps> = {}): ApplyLayerOutcomeDeps {
  return {
    getRoundRoomId: vi.fn(async () => "room-1"),
    resolveRoundOutcome: vi.fn(
      async (): Promise<ResolveRoundOutcome> => ({
        outcome: "brewer",
        layer: 0,
        brewerId: "p1",
        brewerSource: "default",
        cupsMade: 3,
        noModifierGain: false,
        trace: [],
      }),
    ),
    resolveDeclaredNumberTeaMaker: vi.fn(async () => null),
    resolveRound: vi.fn(async () => {}),
    advanceRoundLayer: vi.fn(async () => 1),
    broadcastRoundRevealed: vi.fn(async () => {}),
    broadcastLayerTied: vi.fn(async () => {}),
    recordPendingRoundReplay: vi.fn(async () => false),
    broadcastRoundReplayChanged: vi.fn(async () => {}),
    ...overrides,
  };
}

const twoRollLayer: CompletedLayer = {
  layer: 0,
  rolls: [
    { playerId: "p1", value: 5, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false },
    { playerId: "p2", value: 12, modifierSnapshot: 0, discardedValue: null, enteredByAdmin: false },
  ],
};

describe("applyLayerOutcome", () => {
  it("persists a brewer outcome via the 4-arg resolve_round and broadcasts the reveal", async () => {
    const deps = fakeDeps();

    await applyLayerOutcome(supabase, "round-1", twoRollLayer, deps);

    expect(deps.resolveRoundOutcome).toHaveBeenCalledWith(supabase, "round-1");
    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p1", 3);
    expect(deps.broadcastRoundRevealed).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 0,
      brewerId: "p1",
      cupsMade: 3,
      rolls: [
        { playerId: "p1", value: 5, discardedValue: null, enteredByAdmin: false },
        { playerId: "p2", value: 12, discardedValue: null, enteredByAdmin: false },
      ],
    });
    expect(deps.advanceRoundLayer).not.toHaveBeenCalled();
    expect(deps.broadcastLayerTied).not.toHaveBeenCalled();
  });

  it("takes cupsMade from the resolver result, not this layer's roller count", async () => {
    // Only p1/p2 rolled this reroll layer, but the round has 3 participants.
    const deps = fakeDeps({
      resolveRoundOutcome: vi.fn(
        async (): Promise<ResolveRoundOutcome> => ({
          outcome: "brewer",
          layer: 1,
          brewerId: "p1",
          brewerSource: "default",
          cupsMade: 3,
          noModifierGain: false,
          trace: [],
        }),
      ),
    });

    await applyLayerOutcome(supabase, "round-1", { ...twoRollLayer, layer: 1 }, deps);

    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p1", 3);
    // The broadcast carries which layer actually decided it (issue #220
    // piece 4).
    expect(deps.broadcastRoundRevealed).toHaveBeenCalledWith(
      supabase,
      "room-1",
      expect.objectContaining({ layer: 1 }),
    );
  });

  it("burns the declared-number one-shot only when the resolver picked the brewer that way", async () => {
    const declaredDeps = fakeDeps({
      resolveRoundOutcome: vi.fn(
        async (): Promise<ResolveRoundOutcome> => ({
          outcome: "brewer",
          layer: 0,
          brewerId: "p2",
          brewerSource: "declared_number",
          cupsMade: 3,
          noModifierGain: false,
          trace: [],
        }),
      ),
    });
    await applyLayerOutcome(supabase, "round-1", twoRollLayer, declaredDeps);
    expect(declaredDeps.resolveDeclaredNumberTeaMaker).toHaveBeenCalledWith(supabase, "round-1", 0);

    // A default-pick brewer must not touch it.
    const defaultDeps = fakeDeps();
    await applyLayerOutcome(supabase, "round-1", twoRollLayer, defaultDeps);
    expect(defaultDeps.resolveDeclaredNumberTeaMaker).not.toHaveBeenCalled();
  });

  it("passes the no-modifier-gain flag through to resolve_round (Drip Tray)", async () => {
    const deps = fakeDeps({
      resolveRoundOutcome: vi.fn(
        async (): Promise<ResolveRoundOutcome> => ({
          outcome: "brewer",
          layer: 0,
          brewerId: "p2",
          brewerSource: "tea_maker_override:highest_roll",
          cupsMade: 3,
          noModifierGain: true,
          trace: [],
        }),
      ),
    });

    await applyLayerOutcome(supabase, "round-1", twoRollLayer, deps);

    expect(deps.resolveRound).toHaveBeenCalledWith(supabase, "round-1", "p2", 3, true);
  });

  it("advances to the next reroll layer and broadcasts the tie on a tie outcome", async () => {
    const deps = fakeDeps({
      resolveRoundOutcome: vi.fn(
        async (): Promise<ResolveRoundOutcome> => ({
          outcome: "tie",
          layer: 0,
          tiedPlayerIds: ["p1", "p2"],
          cupsMade: 3,
          trace: [],
        }),
      ),
    });

    await applyLayerOutcome(supabase, "round-1", twoRollLayer, deps);

    expect(deps.advanceRoundLayer).toHaveBeenCalledWith(supabase, "round-1", ["p1", "p2"]);
    expect(deps.broadcastLayerTied).toHaveBeenCalledWith(supabase, "room-1", {
      roundId: "round-1",
      layer: 1,
      tiedPlayerIds: ["p1", "p2"],
    });
    expect(deps.resolveRound).not.toHaveBeenCalled();
    expect(deps.broadcastRoundRevealed).not.toHaveBeenCalled();
  });

  it("looks up the room via the given roundId", async () => {
    const deps = fakeDeps();

    await applyLayerOutcome(supabase, "round-42", twoRollLayer, deps);

    expect(deps.getRoundRoomId).toHaveBeenCalledWith(supabase, "round-42");
  });

  it("records a pending round replay after announcing, and nudges devices when one is pending (issue #315)", async () => {
    const deps = fakeDeps({ recordPendingRoundReplay: vi.fn(async () => true) });

    await applyLayerOutcome(supabase, "round-1", twoRollLayer, deps);

    // Recorded only after the reveal has been broadcast — the round announces
    // normally first (spec §11).
    expect(deps.recordPendingRoundReplay).toHaveBeenCalledWith(supabase, "round-1");
    const revealOrder = (deps.broadcastRoundRevealed as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
    const recordOrder = (deps.recordPendingRoundReplay as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
    expect(recordOrder).toBeGreaterThan(revealOrder);
    expect(deps.broadcastRoundReplayChanged).toHaveBeenCalledWith(supabase, "room-1", { roundId: "round-1" });
  });

  it("does not nudge devices when no round replay is pending (the ordinary round)", async () => {
    const deps = fakeDeps();

    await applyLayerOutcome(supabase, "round-1", twoRollLayer, deps);

    expect(deps.recordPendingRoundReplay).toHaveBeenCalledWith(supabase, "round-1");
    expect(deps.broadcastRoundReplayChanged).not.toHaveBeenCalled();
  });

  it("never records a pending round replay on a tie outcome", async () => {
    const deps = fakeDeps({
      resolveRoundOutcome: vi.fn(
        async (): Promise<ResolveRoundOutcome> => ({
          outcome: "tie",
          layer: 0,
          tiedPlayerIds: ["p1", "p2"],
          cupsMade: 3,
          trace: [],
        }),
      ),
    });

    await applyLayerOutcome(supabase, "round-1", twoRollLayer, deps);

    expect(deps.recordPendingRoundReplay).not.toHaveBeenCalled();
  });
});
