import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedActiveEffect,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #316 -- Effect Invocation
// Group A (Saucerer's Apprentice / Genie in the Teapot / Brew-merang),
// migration 0093, on top of #307 / #308 (the recursive negate fixpoint) and
// #309 / #344 (ward). Assertions are on externally observable outcomes only:
// the emitted Resolution Trace, the brewer, and the resolver-written
// spell_casts.copied_cast_id / seized_by_cast_id caches.

type TraceStep = {
  index: number;
  display_kind: string;
  source_cast: { cast_id: string | null; card_name: string | null; caster_player_id: string | null };
  target_player: string | null;
  before: { type: string; value: number | string | null };
  after: { type: string; value: number | string | null };
  outcome: string;
  invocation_kind?: string;
  reason?: string;
  copied_cast_id?: string | null;
  seized_by_cast_id?: string | null;
};

type ResolveOutcome = {
  outcome: "brewer" | "tie";
  brewer_id: string | null;
  trace: TraceStep[];
};

describe.skipIf(!hasAnonTestEnv)("Effect Invocation -- Group A (issue #316)", () => {
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

  async function seedRoll(roundId: string, playerId: string, value: number, modifierSnapshot = 0) {
    const { error } = await admin.from("rolls").insert({
      round_id: roundId,
      player_id: playerId,
      layer: 0,
      value,
      input_mode: "manual",
      modifier_snapshot: modifierSnapshot,
    });
    expect(error).toBeNull();
  }

  async function openAndCloseRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    const { error: cErr } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(cErr).toBeNull();
    return roundId as string;
  }

  async function openWindow(roundId: string) {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "closed" })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** Force-hold a donor card, return it to the deck, and return its instance id. */
  async function donorInstance(playerId: string, donorCard: string) {
    const instanceId = await forceHold(admin, playerId, donorCard);
    await admin
      .from("spell_deck_instances")
      .update({ location: "in_deck", held_by_player: null })
      .eq("id", instanceId);
    return instanceId;
  }

  async function seedCast(
    roundId: string,
    casterId: string,
    instanceId: string,
    row: {
      effectKind: string | null;
      effectParams?: Record<string, unknown>;
      targetPlayerId: string | null;
      reactionWindowId?: string;
      castInputs?: Record<string, unknown> | null;
      parentCastId?: string;
      targetRole?: string;
    },
  ) {
    const { data, error } = await admin
      .from("spell_casts")
      .insert({
        round_id: roundId,
        caster_id: casterId,
        card_instance_id: instanceId,
        target_player_id: row.targetPlayerId,
        target_pending: false,
        effect_kind: row.effectKind,
        effect_params: row.effectParams ?? {},
        reaction_window_id: row.reactionWindowId ?? null,
        cast_inputs: row.castInputs ?? null,
        parent_cast_id: row.parentCastId ?? null,
        target_role: row.targetRole ?? null,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function resolve(client: SupabaseClient, roundId: string): Promise<ResolveOutcome> {
    const { data, error } = await client.rpc("resolve_round", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as ResolveOutcome;
  }

  async function castRow(castId: string) {
    const { data } = await admin
      .from("spell_casts")
      .select("target_player_id, target_role, negated, copied_cast_id, seized_by_cast_id")
      .eq("id", castId)
      .single();
    return data!;
  }

  // ---------------------------------------------------------------------------
  // Saucerer's Apprentice -- copy
  // ---------------------------------------------------------------------------

  it("copies a stack cast onto the Apprentice caster; the original still resolves", async () => {
    const p1 = await signUp("ei-copy-1");
    const p2 = await signUp("ei-copy-2");
    const p3 = await signUp("ei-copy-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p2.googleSub, "Lucky Sip");
    const srcCast = await seedCast(roundId, p2.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 6 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });

    const saucInst = await donorInstance(p3.googleSub, "Saucerer's Apprentice");
    const saucCast = await seedCast(roundId, p3.googleSub, saucInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { copied_cast_id: srcCast, copy_inputs: {} },
    });

    const out = await resolve(p1.client, roundId);

    // original: p2 still gets +6
    const p2Steps = out.trace.filter((s) => s.target_player === p2.googleSub && s.display_kind === "flat_modifier");
    expect(p2Steps).toHaveLength(1);
    expect(p2Steps[0]!.after.value).toBe(6);

    // copy: a `copy` header step + a flat_modifier step landing on p3
    const copyStep = out.trace.find((s) => s.display_kind === "copy");
    expect(copyStep).toBeTruthy();
    expect(copyStep!.source_cast.cast_id).toBe(saucCast);
    const p3Steps = out.trace.filter((s) => s.target_player === p3.googleSub && s.display_kind === "flat_modifier");
    expect(p3Steps).toHaveLength(1);
    expect(p3Steps[0]!.after.value).toBe(6);

    // resolver wrote the copied_cast_id cache onto the Saucerer row
    expect((await castRow(saucCast)).copied_cast_id).toBe(srcCast);

    // p1 untouched (0) beats p2 & p3 (6) -> brewer p1
    expect(out.brewer_id).toBe(p1.googleSub);
  });

  it("the copy draws its own RNG -- a copied dice_modifier re-rolls independently", async () => {
    const p1 = await signUp("ei-rng-1");
    const p2 = await signUp("ei-rng-2");
    const p3 = await signUp("ei-rng-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p2.googleSub, "Lucky Sip");
    const srcCast = await seedCast(roundId, p2.googleSub, srcInst, {
      effectKind: "dice_modifier",
      effectParams: { dice: "1d6", sign: 1 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
      castInputs: { dice_roll: 3 },
    });

    const saucInst = await donorInstance(p3.googleSub, "Saucerer's Apprentice");
    await seedCast(roundId, p3.googleSub, saucInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      // copy RNG is keyed by the source row's id (see _rr_build_copy_inputs).
      castInputs: { copied_cast_id: srcCast, copy_inputs: { by_cast: { [srcCast]: { dice_roll: 5 } } } },
    });

    const out = await resolve(p1.client, roundId);

    const p2Dice = out.trace.find((s) => s.target_player === p2.googleSub && s.display_kind === "dice_modifier");
    const p3Dice = out.trace.find((s) => s.target_player === p3.googleSub && s.display_kind === "dice_modifier");
    expect(p2Dice!.after.value).toBe(3); // source keeps its own roll
    expect(p3Dice!.after.value).toBe(5); // copy uses its independently drawn roll
  });

  it("copying a negated / broken-chain cast is a no-op", async () => {
    const p1 = await signUp("ei-nocopy-1");
    const p2 = await signUp("ei-nocopy-2");
    const p3 = await signUp("ei-nocopy-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p2.googleSub, "Lucky Sip");
    const srcCast = await seedCast(roundId, p2.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 6 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });

    // p1 counters the source and wins the contest -> source negated
    const ctrInst = await donorInstance(p1.googleSub, "Tannin Tantrum");
    await seedCast(roundId, p1.googleSub, ctrInst, {
      effectKind: "contested_negate",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { dc_d20: 20, dc: 10 },
    });

    const saucInst = await donorInstance(p3.googleSub, "Saucerer's Apprentice");
    const saucCast = await seedCast(roundId, p3.googleSub, saucInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { copied_cast_id: srcCast, copy_inputs: {} },
    });

    const out = await resolve(p1.client, roundId);

    const copyStep = out.trace.find((s) => s.display_kind === "copy");
    expect(copyStep).toBeTruthy();
    expect(copyStep!.outcome).toBe("no-op");
    expect(copyStep!.reason).toBe("source broken");
    // nothing landed on p3
    expect(out.trace.some((s) => s.target_player === p3.googleSub && s.display_kind === "flat_modifier")).toBe(false);
    // no copied_cast_id cache written for a dead copy
    expect((await castRow(saucCast)).copied_cast_id).toBeNull();
  });

  it("a block_copy ward blocks the copy -- card burned, outcome blocked", async () => {
    const p1 = await signUp("ei-wardcopy-1");
    const p2 = await signUp("ei-wardcopy-2");
    const p3 = await signUp("ei-wardcopy-3");
    // p1 holds Bag for Life (block_copy) and is the source caster.
    await seedActiveEffect(admin, cleanup, {
      roomId: p1.roomId,
      targetPlayerId: p1.googleSub,
      casterId: p1.googleSub,
      cardName: "Bag for Life",
      effectKind: "ward",
      effectParams: { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
      roundsRemaining: null,
    });

    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p1.googleSub, "Lucky Sip");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 6 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });

    const saucInst = await donorInstance(p3.googleSub, "Saucerer's Apprentice");
    const saucCast = await seedCast(roundId, p3.googleSub, saucInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { copied_cast_id: srcCast, copy_inputs: {} },
    });

    const out = await resolve(p1.client, roundId);

    const warded = out.trace.find((s) => s.display_kind === "warded" && s.invocation_kind === "copy");
    expect(warded).toBeTruthy();
    expect(warded!.outcome).toBe("blocked");
    expect(out.trace.some((s) => s.target_player === p3.googleSub && s.display_kind === "flat_modifier")).toBe(false);
    // the invoking row still exists -- the card was spent
    expect(await castRow(saucCast)).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Brew-merang -- seize
  // ---------------------------------------------------------------------------

  it("retargets the seized cast to its own caster", async () => {
    const p1 = await signUp("ei-seize-1");
    const p2 = await signUp("ei-seize-2");
    const p3 = await signUp("ei-seize-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    // p1 buffs p2 by +5.
    const srcInst = await donorInstance(p1.googleSub, "Brewer's Blessing");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });

    // p3 Brew-merangs it -> +5 now lands on p1 (the caster).
    const bmInst = await donorInstance(p3.googleSub, "Brew-merang");
    const bmCast = await seedCast(roundId, p3.googleSub, bmInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: srcCast },
    });

    const out = await resolve(p1.client, roundId);

    const seizeStep = out.trace.find((s) => s.display_kind === "seize");
    expect(seizeStep).toBeTruthy();
    expect(seizeStep!.target_player).toBe(p1.googleSub);

    const p1Buff = out.trace.find((s) => s.target_player === p1.googleSub && s.display_kind === "flat_modifier");
    expect(p1Buff!.after.value).toBe(5);
    expect(out.trace.some((s) => s.target_player === p2.googleSub && s.display_kind === "flat_modifier")).toBe(false);

    // resolver wrote the seized_by_cast_id cache onto the source row
    expect((await castRow(srcCast)).seized_by_cast_id).toBe(bmCast);
  });

  it("a multi-target seized cast collapses to just the caster", async () => {
    const p1 = await signUp("ei-collapse-1");
    const p2 = await signUp("ei-collapse-2");
    const p3 = await signUp("ei-collapse-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    // p1 casts a TABLE -3 (one row per player, one shared instance).
    const srcInst = await donorInstance(p1.googleSub, "Lucky Sip");
    let firstRow: string | null = null;
    for (const t of [p1, p2, p3]) {
      const id = await seedCast(roundId, p1.googleSub, srcInst, {
        effectKind: "flat_modifier",
        effectParams: { delta: -3 },
        targetPlayerId: t.googleSub,
        reactionWindowId: win,
        targetRole: "TABLE",
      });
      firstRow ??= id;
    }

    // p2 Brew-merangs it -> only p1 (the caster) takes the -3.
    const bmInst = await donorInstance(p2.googleSub, "Brew-merang");
    await seedCast(roundId, p2.googleSub, bmInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: firstRow!,
      targetRole: "CARD",
      castInputs: { seized_cast_id: firstRow },
    });

    const out = await resolve(p1.client, roundId);

    const applied = out.trace.filter((s) => s.display_kind === "flat_modifier" && s.after.value === -3);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.target_player).toBe(p1.googleSub);
  });

  it("countering the Brew-merang undoes the seize", async () => {
    const p1 = await signUp("ei-unseize-1");
    const p2 = await signUp("ei-unseize-2");
    const p3 = await signUp("ei-unseize-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p1.googleSub, "Brewer's Blessing");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });

    const bmInst = await donorInstance(p3.googleSub, "Brew-merang");
    const bmCast = await seedCast(roundId, p3.googleSub, bmInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: srcCast },
    });

    // p2 counters the Brew-merang and wins -> seize never happens.
    const ctrInst = await donorInstance(p2.googleSub, "Tannin Tantrum");
    await seedCast(roundId, p2.googleSub, ctrInst, {
      effectKind: "contested_negate",
      effectParams: {},
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: bmCast,
      targetRole: "CARD",
      castInputs: { dc_d20: 20, dc: 10 },
    });

    const out = await resolve(p1.client, roundId);

    const seizeStep = out.trace.find((s) => s.display_kind === "seize");
    expect(seizeStep!.outcome).toBe("no-op");
    expect(seizeStep!.reason).toBe("countered");

    // the source resolves normally on its original target p2
    const p2Buff = out.trace.find((s) => s.target_player === p2.googleSub && s.display_kind === "flat_modifier");
    expect(p2Buff!.after.value).toBe(5);
    expect((await castRow(srcCast)).seized_by_cast_id).toBeNull();
  });

  it("a block_copy ward blocks the seize -- card burned, source resolves normally", async () => {
    const p1 = await signUp("ei-wardseize-1");
    const p2 = await signUp("ei-wardseize-2");
    const p3 = await signUp("ei-wardseize-3");
    await seedActiveEffect(admin, cleanup, {
      roomId: p1.roomId,
      targetPlayerId: p1.googleSub,
      casterId: p1.googleSub,
      cardName: "Bag for Life",
      effectKind: "ward",
      effectParams: { polarity: ["positive", "negative"], domain: ["modifier"], block_copy: true },
      roundsRemaining: null,
    });

    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p1.googleSub, "Brewer's Blessing");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });

    const bmInst = await donorInstance(p3.googleSub, "Brew-merang");
    await seedCast(roundId, p3.googleSub, bmInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: srcCast },
    });

    const out = await resolve(p1.client, roundId);

    const warded = out.trace.find((s) => s.display_kind === "warded" && s.invocation_kind === "seize");
    expect(warded!.outcome).toBe("blocked");
    // seize blocked -> source still resolves on p2
    const p2Buff = out.trace.find((s) => s.target_player === p2.googleSub && s.display_kind === "flat_modifier");
    expect(p2Buff!.after.value).toBe(5);
    expect((await castRow(srcCast)).seized_by_cast_id).toBeNull();
  });

  it("resolve_round is idempotent over an invocation round", async () => {
    const p1 = await signUp("ei-idem-1");
    const p2 = await signUp("ei-idem-2");
    const p3 = await signUp("ei-idem-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p1.googleSub, "Brewer's Blessing");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });
    const bmInst = await donorInstance(p3.googleSub, "Brew-merang");
    await seedCast(roundId, p3.googleSub, bmInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: srcCast },
    });

    const first = await resolve(p1.client, roundId);
    const second = await resolve(p1.client, roundId);
    expect(second.trace).toEqual(first.trace);
    expect(second.brewer_id).toBe(first.brewer_id);
  });

  // ---------------------------------------------------------------------------
  // Genie in the Teapot -- invoke (RPC path)
  // ---------------------------------------------------------------------------

  it("names an in_deck non-Epic Action card, resolves it, and does not move the instance", async () => {
    const p1 = await signUp("ei-genie-1");
    const p2 = await signUp("ei-genie-2");

    const { data: roundId, error } = await p1.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    // p2 must be a participant before Genie can target them pre-roll.
    const { error: dErr } = await p2.client.rpc("declare_in", { p_round_id: roundId });
    expect(dErr).toBeNull();

    await forceHold(admin, p1.googleSub, "Genie in the Teapot");
    // Genie names Cold Tea (Action, OPPONENT, flat_modifier -3), targeting p2.
    const { data: castId, error: castErr } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p2.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(castErr).toBeNull();
    expect(castId).toBeTruthy();

    // every emitted row carries the invoked-card tag and Cold Tea's effects
    // (compound: TARGET flat_modifier -3 + CASTER dice_modifier 1d4).
    const { data: rows } = await admin
      .from("spell_casts")
      .select("effect_kind, effect_params, target_player_id, cast_inputs")
      .eq("round_id", roundId)
      .eq("caster_id", p1.googleSub);
    expect(rows).toHaveLength(2);
    for (const r of rows!) {
      expect((r.cast_inputs as { invoked_card?: string }).invoked_card).toBe("Cold Tea");
    }
    const flat = rows!.find((r) => r.effect_kind === "flat_modifier")!;
    expect(flat.effect_params).toMatchObject({ delta: -3 });
    expect(flat.target_player_id).toBe(p2.googleSub);

    // Cold Tea's own instance was never moved (ethereal).
    const { data: coldTea } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "Cold Tea")
      .single();
    expect(coldTea!.location).toBe("in_deck");
  });

  it("two Genies naming the same card both resolve; the named instance never moves", async () => {
    const p1 = await signUp("ei-genie2-1");
    const p2 = await signUp("ei-genie2-2");
    const p3 = await signUp("ei-genie2-3");

    const { data: roundId } = await p1.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    for (const o of [p2, p3]) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }

    // p1 Genies Cold Tea onto p3. Casting returns the Genie instance to the
    // deck, so p2 can then hold it and Genie the same card.
    await forceHold(admin, p1.googleSub, "Genie in the Teapot");
    const { error: e1 } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p3.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(e1).toBeNull();

    await forceHold(admin, p2.googleSub, "Genie in the Teapot");
    const { error: e2 } = await p2.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p3.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(e2).toBeNull();

    // both Genies' flat_modifier rows are present
    const { data: p1rows } = await admin
      .from("spell_casts").select("effect_kind").eq("round_id", roundId).eq("caster_id", p1.googleSub);
    const { data: p2rows } = await admin
      .from("spell_casts").select("effect_kind").eq("round_id", roundId).eq("caster_id", p2.googleSub);
    expect(p1rows!.some((r) => r.effect_kind === "flat_modifier")).toBe(true);
    expect(p2rows!.some((r) => r.effect_kind === "flat_modifier")).toBe(true);

    // Cold Tea's instance was never moved by either Genie
    const { data: coldTea } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", "Cold Tea")
      .single();
    expect(coldTea!.location).toBe("in_deck");
  });

  it("a Brew-merang seizing a Brew-merang terminates and resolves coherently", async () => {
    // The deck holds one Brew-merang instance, so the outer seize rides a
    // second donor instance carrying only a seized_cast_id pointer (the
    // resolver keys invocation off cast_inputs + effect_kind IS NULL, not the
    // card). Documented one-level, non-cascading behaviour: the chain
    // terminates, resolve_round does not error and stays idempotent, and the
    // inner Brew-merang ends up marked seized by the outer one.
    const p1 = await signUp("ei-bb-1");
    const p2 = await signUp("ei-bb-2");
    const p3 = await signUp("ei-bb-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);
    const win = await openWindow(roundId);

    const srcInst = await donorInstance(p1.googleSub, "Brewer's Blessing");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p2.googleSub,
      reactionWindowId: win,
      targetRole: "TARGET",
    });

    const bm1Inst = await donorInstance(p2.googleSub, "Brew-merang");
    const bm1Cast = await seedCast(roundId, p2.googleSub, bm1Inst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: srcCast },
    });

    const bm2Inst = await donorInstance(p3.googleSub, "Lucky Sip");
    const bm2Cast = await seedCast(roundId, p3.googleSub, bm2Inst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win,
      parentCastId: bm1Cast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: bm1Cast },
    });

    const first = await resolve(p1.client, roundId);
    const second = await resolve(p1.client, roundId);
    expect(second.trace).toEqual(first.trace); // terminates + idempotent

    // the outer Brew-merang's seize of the inner one is recorded
    expect((await castRow(bm1Cast)).seized_by_cast_id).toBe(bm2Cast);
  });

  it("rejects a name whose sole edition instance is not in_deck (RFB50)", async () => {
    const p1 = await signUp("ei-genie-held-1");
    const p2 = await signUp("ei-genie-held-2");

    const { data: roundId } = await p1.client.rpc("start_round");
    cleanup.trackRound(roundId as string);

    // Cold Tea is now held by p2 -> not nameable.
    await forceHold(admin, p2.googleSub, "Cold Tea");
    await forceHold(admin, p1.googleSub, "Genie in the Teapot");

    const { error } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p2.googleSub,
      p_invoked_card_name: "Cold Tea",
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB50");
  });

  it("rejects naming an Epic card / Genie itself (RFB50)", async () => {
    const p1 = await signUp("ei-genie-epic-1");
    await signUp("ei-genie-epic-2");
    const { data: roundId } = await p1.client.rpc("start_round");
    cleanup.trackRound(roundId as string);
    await forceHold(admin, p1.googleSub, "Genie in the Teapot");

    const { error } = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_target_player_id: null,
      p_invoked_card_name: "Genie in the Teapot",
    });
    expect(error?.code).toBe("RFB50");
  });

  // ---------------------------------------------------------------------------
  // No meta-invocation (RPC path)
  // ---------------------------------------------------------------------------

  it("an invocation card cannot invoke another invocation card (RFB49)", async () => {
    const p1 = await signUp("ei-meta-1");
    const p2 = await signUp("ei-meta-2");
    const p3 = await signUp("ei-meta-3");
    const roundId = await openAndCloseRound(p1, [p2, p3]);
    await seedRoll(roundId, p1.googleSub, 10);
    await seedRoll(roundId, p2.googleSub, 10);
    await seedRoll(roundId, p3.googleSub, 10);

    // A real open reaction window so cast_reaction_spell_card runs.
    const { data: win, error: winErr } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status: "open" })
      .select("id")
      .single();
    expect(winErr).toBeNull();

    // p1 has a plain cast on the stack; p2 Brew-merangs it.
    const srcInst = await donorInstance(p1.googleSub, "Brewer's Blessing");
    const srcCast = await seedCast(roundId, p1.googleSub, srcInst, {
      effectKind: "flat_modifier",
      effectParams: { delta: 5 },
      targetPlayerId: p3.googleSub,
      reactionWindowId: win!.id,
      targetRole: "TARGET",
    });
    const bmInst = await donorInstance(p2.googleSub, "Brew-merang");
    const bmCast = await seedCast(roundId, p2.googleSub, bmInst, {
      effectKind: null,
      targetPlayerId: null,
      reactionWindowId: win!.id,
      parentCastId: srcCast,
      targetRole: "CARD",
      castInputs: { seized_cast_id: srcCast },
    });

    // p3 tries to Saucerer's-Apprentice-copy the Brew-merang -> RFB49.
    await forceHold(admin, p3.googleSub, "Saucerer's Apprentice");
    const { error } = await p3.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_cast_id: bmCast,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("RFB49");
  });
});
