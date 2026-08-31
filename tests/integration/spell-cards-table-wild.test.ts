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
    const [caster, target] = await Promise.all([
      signUp("boil-over-caster"),
      signUp("boil-over-target"),
    ]);
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
    const [caster, target] = await Promise.all([
      signUp("scalding-pour-caster"),
      signUp("scalding-pour-target"),
    ]);
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
    const [caster, target] = await Promise.all([
      signUp("calami-tea-caster"),
      signUp("calami-tea-target"),
    ]);
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
    const [caster, t1, t2, t3, t4] = await Promise.all([
      signUp("calami-tea-overflow-caster"),
      signUp("calami-tea-overflow-t1"),
      signUp("calami-tea-overflow-t2"),
      signUp("calami-tea-overflow-t3"),
      signUp("calami-tea-overflow-t4"),
    ]);
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
    const [caster, target] = await Promise.all([
      signUp("wild-brew-caster"),
      signUp("wild-brew-target"),
    ]);
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
      .select("effect_kind, effect_params, cast_inputs")
      .eq("round_id", roundId)
      .eq("effect_kind", "wild_dispatch")
      .order("cast_at", { ascending: true })
      .limit(1);
    expect(dispatchError).toBeNull();
    // #312: resolved_value is dropped; the d6 branch pick is recorded into the
    // Cast Log (issue #307) as cast_inputs.branch, the resolver's only source.
    const branch = (dispatchRows![0]!.cast_inputs as { branch: number }).branch;
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
    const [caster, target] = await Promise.all([
      signUp("roll-swap-caster"),
      signUp("roll-swap-target"),
    ]);

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
    const [caster, target] = await Promise.all([
      signUp("roll-flip-caster"),
      signUp("roll-flip-target"),
    ]);

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
    const [caster, target] = await Promise.all([
      signUp("drip-tray-caster"),
      signUp("drip-tray-target"),
    ]);

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
    const [caster, target] = await Promise.all([signUp("saucer-caster"), signUp("saucer-target")]);
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
    const [caster, target] = await Promise.all([
      signUp("saucer-missing-number-caster"),
      signUp("saucer-missing-number-target"),
    ]);
    await forceHold(admin, caster.googleSub, "Inscribed Saucer");

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).not.toBeNull();
  });

  it("Kettle Crash (TABLE/reset_persistent_modifier) zeroes every room modifier at cast time (#285)", async () => {
    const [caster, target, bystander] = await Promise.all([
      signUp("kettle-crash-caster"),
      signUp("kettle-crash-target"),
      signUp("kettle-crash-bystander"),
    ]);
    await forceHold(admin, caster.googleSub, "Kettle Crash");

    // Non-zero modifiers across the table, including a room member who never
    // declares into the round — the reset is room-wide, not round-scoped.
    for (const [player, modifier] of [
      [caster, 5],
      [target, -4],
      [bystander, 9],
    ] as const) {
      await admin
        .from("room_players")
        .update({ modifier })
        .eq("room_id", caster.roomId)
        .eq("player_id", player.googleSub);
    }

    const { data: roundId } = await caster.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await target.client.rpc("declare_in", { p_round_id: roundId });

    const { data: castId, error: castError } = await caster.client.rpc("cast_spell_card", {
      p_round_id: roundId,
    });
    expect(castError).toBeNull();
    expect(castId).toBeTruthy();

    const { data: roomPlayers, error: rpError } = await admin
      .from("room_players")
      .select("player_id, modifier")
      .eq("room_id", caster.roomId);
    expect(rpError).toBeNull();
    expect(roomPlayers!.length).toBeGreaterThanOrEqual(3);
    for (const row of roomPlayers!) {
      expect(row.modifier).toBe(0);
    }

    // The audit spell_casts row is still written.
    const { data: auditRows } = await admin
      .from("spell_casts")
      .select("effect_kind, target_role")
      .eq("round_id", roundId)
      .eq("effect_kind", "reset_persistent_modifier");
    expect(auditRows).toHaveLength(1);
    expect(auditRows![0]!.target_role).toBe("TABLE");
  });
});
