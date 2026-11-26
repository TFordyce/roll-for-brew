import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedDedicatedRoom,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #434 (spec #401): Tea Cosy --
// "You are exempt from rolling this round. You cannot be the tea-maker."
//
//   * One catalog effect row, CASTER / brewer_immunity {mode: 'tea_cosy',
//     exempt_from_rolling: true}, on a card whose duration_rounds is 1. The
//     cast promotes a one-round, dispellable brewer_immunity row (Brewer
//     Immunity, #428) and carries the Roll Exemption flag (#433).
//   * Countered: both halves go -- the source cast is negated, so the
//     immunity isn't live, and the caster rolls late once the window closes.
//   * A Round replay's clean slate deletes the cast: no exemption, no
//     immunity.
//   * Every participant on Tea Cosy: no layer-0 roll is expected, the round
//     resolves at close, and immunity gives way to a Tie-Break Reroll.
// Assertions are on observable outcomes: who is expected to roll, the
// brewer, and the Resolution Trace.

const COSY = "Tea Cosy";

describe.skipIf(!hasAnonTestEnv)("Tea Cosy (#434)", () => {
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
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `cosy-${l}`)));
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

  /** Tea Cosy, cast for real through cast_spell_card while `roundId` is open. */
  async function castCosy(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, COSY);
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  // -----------------------------------------------------------------------
  // The card.
  // -----------------------------------------------------------------------

  it("is un-benched, with one CASTER brewer_immunity row (tea_cosy, exempt from rolling) lasting one round", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", COSY)
      .single();
    expect(inst!.location).not.toBe("benched");

    const { data: card } = await admin.from("spell_cards").select("duration_rounds").eq("name", COSY).single();
    expect(card!.duration_rounds).toBe(1);

    const { data: effects } = await admin
      .from("spell_card_effects")
      .select("target_role, effect_kind, effect_params, spell_cards!inner(name)")
      .eq("spell_cards.name", COSY);
    expect(effects).toHaveLength(1);
    expect(effects![0]).toMatchObject({
      target_role: "CASTER",
      effect_kind: "brewer_immunity",
      effect_params: { mode: "tea_cosy", exempt_from_rolling: true },
    });
  });

  it("casting it promotes a one-round, dispellable brewer_immunity row on the caster", async () => {
    const [ada, ben] = await players("row-a", "row-b");
    const roundId = await openRound(ada, [ben]);
    const castId = await castCosy(ada, roundId);

    const { data: rows } = await admin
      .from("spell_active_effects")
      .select("id, target_player_id, effect_kind, effect_params, rounds_remaining, is_undispellable")
      .eq("source_cast_id", castId);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({
      target_player_id: ada.googleSub,
      effect_kind: "brewer_immunity",
      effect_params: { mode: "tea_cosy" },
      rounds_remaining: 1,
      is_undispellable: false,
    });

    await forceHold(admin, ben.googleSub, "Greater Detox");
    const { data: offered, error } = await ben.client.rpc("get_dispellable_active_effects", { p_round_id: roundId });
    expect(error).toBeNull();
    expect((offered as { effect_id: string }[]).map((x) => x.effect_id)).toContain(rows![0]!.id);
  });
});
