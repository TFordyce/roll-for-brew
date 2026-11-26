import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #428 (spec #401 F2, design #381):
// brewer immunity -- a `brewer_immunity` active effect -- and its first card,
// The Last Cuppa ("You cannot be the tea-maker for the rest of the day under
// any circumstance. No card, force, mark, or curse can override this.").
//
//   * Tier 0 of the precedence ladder (ADR 0005): an immune player is no
//     match at every tier of Phase 5 -- a declared number, an override target
//     and the lowest-roller pool all skip them and fall through.
//   * Everyone immune and no override: immunity gives way to a Tie-Break
//     Reroll among all participants.
//   * The Last Cuppa's row is unbounded (`persist`) and `is_undispellable`:
//     no dispel can end it.
// Assertions are on observable outcomes: the picked brewer, the Resolution
// Trace, the recorded active-effect row, and the dispel RPCs' answers.

describe.skipIf(!hasAnonTestEnv)("brewer immunity -- The Last Cuppa (#428)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  type Player = Awaited<ReturnType<typeof signUpSignInAndEnterRoom>>;

  /** Signs up the players into their own room so no stranger joins a round. */
  async function players<const L extends readonly string[]>(...labels: L): Promise<{ [K in keyof L]: Player }> {
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `imm-${l}`)));
    const roomId = await seedDedicatedRoom(
      admin,
      cleanup,
      ps.map((p) => p.googleSub),
    );
    return ps.map((p) => ({ ...p, roomId })) as { [K in keyof L]: Player };
  }

  async function openRound(starter: Player, others: Player[]): Promise<string> {
    const { data: roundId, error } = await starter.client.rpc("start_round", { p_room_id: starter.roomId });
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  /** The Last Cuppa, cast for real through cast_spell_card while `roundId` is open. */
  async function castLastCuppa(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, "The Last Cuppa");
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  /** A live Last Cuppa immunity row on `holder`, projected from an earlier (resolved) round. */
  async function seedImmunity(holder: Player) {
    return seedActiveEffect(admin, cleanup, {
      roomId: holder.roomId,
      targetPlayerId: holder.googleSub,
      casterId: holder.googleSub,
      cardName: "The Last Cuppa",
      effectKind: "brewer_immunity",
      effectParams: { mode: "last_cuppa", persist: true, undispellable: true, override_proof: true },
      roundsRemaining: null,
    });
  }

  // -----------------------------------------------------------------------
  // The card: un-benched, and casting it projects the immunity row.
  // -----------------------------------------------------------------------

  it("is un-benched and casting it promotes an unbounded, undispellable brewer_immunity row", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "The Last Cuppa")
      .single();
    expect(inst!.location).not.toBe("benched");

    const [caster, other] = await players("cast-a", "cast-b");
    const roundId = await openRound(caster, [other]);
    await castLastCuppa(caster, roundId);

    const { data: casts } = await admin
      .from("spell_casts")
      .select("effect_kind, target_player_id")
      .eq("round_id", roundId);
    expect(casts).toContainEqual({ effect_kind: "brewer_immunity", target_player_id: caster.googleSub });

    const { data: effects } = await admin
      .from("spell_active_effects")
      .select("effect_kind, target_player_id, rounds_remaining, is_undispellable, effect_params")
      .eq("room_id", caster.roomId)
      .eq("effect_kind", "brewer_immunity");
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_player_id: caster.googleSub,
      rounds_remaining: null,
      is_undispellable: true,
      effect_params: { mode: "last_cuppa" },
    });
  });

  // -----------------------------------------------------------------------
  // Undispellable.
  // -----------------------------------------------------------------------

  it("a dispellable immunity row (no undispellable marker) can still be offered to Detox", async () => {
    // Control for the filter: the flag, not the kind, is what blocks dispel.
    const [holder, detoxer] = await players("dsp-ctl-a", "dsp-ctl-b");
    const { effectId } = await seedImmunity(holder); // seeded row: is_undispellable defaults false
    const r = await openRound(holder, [detoxer]);
    await forceHold(admin, detoxer.googleSub, "Greater Detox");
    const { data: offered, error } = await detoxer.client.rpc("get_dispellable_active_effects", { p_round_id: r });
    expect(error).toBeNull();
    expect((offered as { effect_id: string }[]).map((x) => x.effect_id)).toContain(effectId);
  });
});
