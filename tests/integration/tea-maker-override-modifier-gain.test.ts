import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
  closeRoundAs,
  declareInAs,
  startRoundAs,
} from "./setup";

// Runs against a real Supabase stack. Issue #425 (spec #401 F1): the resolver's
// yes/no "no modifier gain" becomes a `modifier_gain` number -- null means the
// normal cups_made, 0 means none, anything else is used as given -- carried
// from resolve_round(uuid) through finalize_layer into the 4-arg
// resolve_round write and rounds.brewer_modifier_gain. The tea_maker_override
// mode is a closed set; an unknown mode is rejected.
describe.skipIf(!hasAnonTestEnv)("tea-maker override modifier gain (#425)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  function signUp(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }

  type Player = Awaited<ReturnType<typeof signUp>>;

  async function openAndCloseRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await startRoundAs(starter.client);
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await declareInAs(o.client, roundId);
      expect(dErr).toBeNull();
    }
    const { error: cErr } = await closeRoundAs(roundId);
    expect(cErr).toBeNull();
    return roundId as string;
  }

  // A tea_maker_override cast recorded straight into the Cast Log, the way
  // the #395 tests seed Drip Tray: no catalog card carries the new
  // modifier_gain parameter yet (the card slices add them).
  async function seedOverrideCast(
    roundId: string,
    caster: Player,
    effectParams: Record<string, unknown>,
    targetPlayerId: string | null = null,
  ) {
    const instanceId = await forceHold(admin, caster.googleSub, "Drip Tray");
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    return admin.from("spell_casts").insert({
      round_id: roundId,
      caster_id: caster.googleSub,
      card_instance_id: instanceId,
      target_player_id: targetPlayerId,
      target_pending: false,
      effect_kind: "tea_maker_override",
      effect_params: effectParams,
    });
  }

  it("rejects a tea_maker_override cast with an unknown or missing mode", async () => {
    const p1 = await signUp("mg-unknown-1");
    const p2 = await signUp("mg-unknown-2");
    const roundId = await openAndCloseRound(p1, [p2]);

    const bogus = await seedOverrideCast(roundId, p1, { mode: "lowest_modifier" });
    expect(bogus.error?.code).toBe("23514");

    const missing = await seedOverrideCast(roundId, p1, { no_modifier_gain: true });
    expect(missing.error?.code).toBe("23514");
  });

  it("accepts every mode in the closed set on a cast", async () => {
    const p1 = await signUp("mg-closed-1");
    const p2 = await signUp("mg-closed-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    for (const mode of ["highest_modifier", "highest_roll", "chosen", "prev_round_highest", "conditional_chosen"]) {
      const { error } = await seedOverrideCast(roundId, p1, { mode });
      expect(error).toBeNull();
    }
  });

  it("rejects a catalog tea_maker_override effect with an unknown mode", async () => {
    const { data: card, error: cardErr } = await admin
      .from("spell_cards")
      .select("id")
      .eq("name", "Drip Tray")
      .single();
    expect(cardErr).toBeNull();

    const { data: inserted, error } = await admin
      .from("spell_card_effects")
      .insert({
        card_id: card!.id,
        target_role: "TABLE",
        effect_kind: "tea_maker_override",
        effect_params: { mode: "lowest_modifier" },
      })
      .select("id");
    // Never leave a stray catalog row behind on the shared stack.
    if (inserted?.length) {
      await admin.from("spell_card_effects").delete().in("id", inserted.map((r) => r.id));
    }
    expect(error?.code).toBe("23514");
  });
});
