import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byTarget,
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real, dedicated test Supabase project. Exercises issue
// #115's TABLE/ALL_OTHER_PLAYERS/CHOSEN_PLAYERS/WILD target-role resolution
// (supabase/migrations/0033_spell_cards_table_wild_casting.sql) — the roles
// 0032 reserved but cast_spell_card/cast_reaction_spell_card rejected
// outright until now.
describe.skipIf(!hasAnonTestEnv)("spell cards: TABLE/WILD casting (#115)", () => {
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

  it("Boil Over (TABLE/set_modifier) fans out to every participant once declare-in closes", async () => {
    const caster = await signUp("boil-over-caster");
    const target = await signUp("boil-over-target");
    await forceHold(admin, caster.googleSub, "Boil Over");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    // Before close_round, the roster isn't final yet — the effect is
    // deferred (a placeholder row, not yet visible to get_round_modifier_effects).
    const { data: beforeCloseAll } = await caster.client.rpc("get_round_modifier_effects", { p_round_id: roundId });
    const beforeClose = byTarget(
      beforeCloseAll as { target_player_id: string }[],
      caster.googleSub,
      target.googleSub,
    );
    expect(beforeClose).toHaveLength(0);

    const { error: closeError } = await caster.client.rpc("close_round", { p_round_id: roundId });
    expect(closeError).toBeNull();

    const { data: effectsAll, error: effectsError } = await caster.client.rpc("get_round_modifier_effects", {
      p_round_id: roundId,
    });
    expect(effectsError).toBeNull();

    const rows = byTarget(
      effectsAll as { target_player_id: string; effect_kind: string; effect_params: Record<string, unknown> }[],
      caster.googleSub,
      target.googleSub,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target_player_id).sort()).toEqual([caster.googleSub, target.googleSub].sort());
    for (const row of rows) {
      expect(row.effect_kind).toBe("set_modifier");
      expect(row.effect_params).toEqual({ value: 0 });
    }
  });

  it("Scalding Pour (ALL_OTHER_PLAYERS/flat_modifier) excludes the caster", async () => {
    const caster = await signUp("scalding-pour-caster");
    const target = await signUp("scalding-pour-target");
    await forceHold(admin, caster.googleSub, "Scalding Pour");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    const { data: effects } = await caster.client.rpc("get_round_modifier_effects", { p_round_id: roundId });
    const rows = byTarget(
      effects as {
        target_player_id: string;
        effect_kind: string;
        effect_params: Record<string, unknown>;
        resolved_value: number | null;
        card_name: string;
        caster_player_id: string;
      }[],
      caster.googleSub,
      target.googleSub,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      target_player_id: target.googleSub,
      effect_kind: "flat_modifier",
      effect_params: { delta: -3 },
      resolved_value: null,
      card_name: "Scalding Pour",
      caster_player_id: caster.googleSub,
    });
  });

  it("Calami-Tea (CHOSEN_PLAYERS) resolves immediately at cast time, not deferred to close_round", async () => {
    const caster = await signUp("calami-tea-caster");
    const target = await signUp("calami-tea-target");
    await forceHold(admin, caster.googleSub, "Calami-Tea");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [target.googleSub],
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: casts, error: castsError } = await admin
      .from("spell_casts")
      .select("target_player_id, effect_kind, effect_params, target_pending, target_role")
      .eq("round_id", roundId);
    expect(castsError).toBeNull();

    const rows = casts as {
      target_player_id: string;
      effect_kind: string;
      effect_params: Record<string, unknown>;
      target_pending: boolean;
      target_role: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_player_id: target.googleSub,
      effect_kind: "flat_modifier",
      target_pending: false,
      target_role: "CHOSEN_PLAYERS",
    });
  });

  it("Calami-Tea rejects more chosen players than the card's max_targets", async () => {
    const caster = await signUp("calami-tea-overflow-caster");
    const t1 = await signUp("calami-tea-overflow-t1");
    const t2 = await signUp("calami-tea-overflow-t2");
    const t3 = await signUp("calami-tea-overflow-t3");
    const t4 = await signUp("calami-tea-overflow-t4");
    await forceHold(admin, caster.googleSub, "Calami-Tea");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    for (const t of [t1, t2, t3, t4]) {
      await t.client.rpc("declare_in", { p_round_id: roundId });
    }

    const { error } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [t1.googleSub, t2.googleSub, t3.googleSub, t4.googleSub],
    });
    expect(error).not.toBeNull();
  });

  it("Wild Brew Surge (WILD) rolls a d6 and dispatches to a structurally-consistent outcome", async () => {
    const caster = await signUp("wild-brew-caster");
    const target = await signUp("wild-brew-target");
    await forceHold(admin, caster.googleSub, "Wild Brew Surge");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: dispatchRows, error: dispatchError } = await admin
      .from("spell_casts")
      .select("resolved_value, effect_kind, effect_params")
      .eq("round_id", roundId)
      .eq("effect_kind", "wild_dispatch")
      .order("cast_at", { ascending: true })
      .limit(1);
    expect(dispatchError).toBeNull();
    const branch = dispatchRows![0]!.resolved_value as number;
    expect(branch).toBeGreaterThanOrEqual(1);
    expect(branch).toBeLessThanOrEqual(6);

    if (branch === 1) {
      const { data: roomPlayers } = await admin
        .from("room_players")
        .select("modifier")
        .in("player_id", [caster.googleSub, target.googleSub]);
      for (const row of roomPlayers ?? []) {
        expect(row.modifier).toBe(0);
      }
    } else if (branch === 4) {
      const { data: placeholder } = await admin
        .from("spell_casts")
        .select("effect_kind, target_role, target_pending")
        .eq("round_id", roundId)
        .eq("effect_kind", "forced_reroll");
      expect(placeholder).toHaveLength(1);
      expect(placeholder![0]).toMatchObject({ target_role: "TABLE", target_pending: true });
    } else if (branch === 6) {
      const { data: pending } = await caster.client.rpc("get_my_pending_casts", { p_round_id: roundId });
      const rows = pending as { card_name: string; target: string }[];
      expect(rows.some((r) => r.card_name === "Wild Brew Surge" && r.target === "WILD")).toBe(true);
    }
  });

  it("apply_roll_swap swaps the layer's highest and lowest rolls in place", async () => {
    const caster = await signUp("roll-swap-caster");
    const target = await signUp("roll-swap-target");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await admin.from("rolls").insert([
      { round_id: roundId, player_id: caster.googleSub, layer: 0, value: 4, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: target.googleSub, layer: 0, value: 18, input_mode: "manual", modifier_snapshot: 0 },
    ]);

    const { data: changes, error } = await caster.client.rpc("apply_roll_swap", { p_round_id: roundId, p_layer: 0 });
    expect(error).toBeNull();

    const byPlayer = new Map((changes as { player_id: string; value: number }[]).map((c) => [c.player_id, c.value]));
    expect(byPlayer.get(caster.googleSub)).toBe(18);
    expect(byPlayer.get(target.googleSub)).toBe(4);
  });

  it("apply_roll_flip flips every roll in the layer to 21 minus its value", async () => {
    const caster = await signUp("roll-flip-caster");
    const target = await signUp("roll-flip-target");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    await admin.from("rolls").insert([
      { round_id: roundId, player_id: caster.googleSub, layer: 0, value: 1, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: target.googleSub, layer: 0, value: 5, input_mode: "manual", modifier_snapshot: 0 },
    ]);

    const { data: changes, error } = await caster.client.rpc("apply_roll_flip", { p_round_id: roundId, p_layer: 0 });
    expect(error).toBeNull();

    const byPlayer = new Map((changes as { player_id: string; value: number }[]).map((c) => [c.player_id, c.value]));
    expect(byPlayer.get(caster.googleSub)).toBe(20);
    expect(byPlayer.get(target.googleSub)).toBe(16);
  });

  it("Drip Tray (tea_maker_override/highest_modifier) surfaces its mode via get_tea_maker_override", async () => {
    const caster = await signUp("drip-tray-caster");
    const target = await signUp("drip-tray-target");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });
    await caster.client.rpc("close_round", { p_round_id: roundId });

    // Drip Tray is Reaction-timed; needs an open reaction window to cast
    // into. forceHold must happen before opening the window — otherwise
    // open_reaction_window sees nobody eligible yet and closes it immediately.
    await forceHold(admin, caster.googleSub, "Drip Tray");

    const { error: openError } = await admin.rpc("open_reaction_window", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(openError).toBeNull();

    const { error: castError } = await caster.client.rpc("cast_reaction_spell_card", { p_round_id: roundId });
    expect(castError).toBeNull();

    const { data: override, error: overrideError } = await caster.client.rpc("get_tea_maker_override", {
      p_round_id: roundId,
    });
    expect(overrideError).toBeNull();
    const rows = override as { mode: string; no_modifier_gain: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      mode: "highest_modifier",
      no_modifier_gain: true,
      chosen_player_id: null,
      target_pending: false,
    });
  });

  it("Inscribed Saucer (declared_number_tea_maker) names the first matching roller and consumes itself", async () => {
    const caster = await signUp("saucer-caster");
    const target = await signUp("saucer-target");
    await forceHold(admin, caster.googleSub, "Inscribed Saucer");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_declared_number: 7,
    });
    expect(castError).toBeNull();

    await caster.client.rpc("close_round", { p_round_id: roundId });

    await admin.from("rolls").insert([
      { round_id: roundId, player_id: caster.googleSub, layer: 0, value: 3, input_mode: "manual", modifier_snapshot: 0 },
      { round_id: roundId, player_id: target.googleSub, layer: 0, value: 7, input_mode: "manual", modifier_snapshot: 0 },
    ]);

    const { data: matched, error: matchError } = await caster.client.rpc("resolve_declared_number_tea_maker", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(matchError).toBeNull();
    expect(matched).toBe(target.googleSub);

    // One-time trigger: a second call finds nothing left to consume.
    const { data: secondMatch } = await caster.client.rpc("resolve_declared_number_tea_maker", {
      p_round_id: roundId,
      p_layer: 0,
    });
    expect(secondMatch).toBeNull();
  });

  it("cast_spell_card rejects a declared_number_tea_maker card cast without a number", async () => {
    const caster = await signUp("saucer-missing-number-caster");
    const target = await signUp("saucer-missing-number-target");
    await forceHold(admin, caster.googleSub, "Inscribed Saucer");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).not.toBeNull();
  });
});
