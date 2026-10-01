// Trace-snapshot corpus (issue #366, map #350 slice S1).
//
// One entry per seeded round. Each `seed` stands up a fresh room, players,
// rolls and a Cast Log, then returns the round id + the client to resolve
// with. The runner (tests/integration/trace-snapshot.test.ts) resolves it
// once, normalises the Trace and diffs it against tests/snapshots/<name>.json.
//
// Coverage bar (enforced by tests/integration/trace-snapshot-coverage.test.ts):
//   • every PHASE_TAG provoked by at least one entry
//   • every WILD d6 branch (1..6) represented
// Entries are deliberately minimal — one clean provocation per phase — so a
// golden diff points straight at the phase that moved. Add more freely; the
// coverage test only fails on a *missing* phase or branch.

import type { Scenario, ScenarioContext } from "./framework";

// tier-derived contested_negate DC: common 2 / rare 5 / epic 10 (migration
// 0080 _rr_tier_default_dc). Lucky Sip is common, so dc_d20 >= 2 succeeds.
const GAMBLER_CONDITION = { condition: { advantage_at_or_above: 15, disadvantage_at_or_below: 5 } };
// Issue #427: PG Tipped's catalog effect_params (migration 0126).
const PG_TIPPED = { mode: "conditional_chosen", condition: "target_below_caster", modifier_gain: 0 };
// Issue #430: Tea Party Revolt's catalog effect_params (migration 0131).
const TEA_PARTY_REVOLT = { mode: "chosen", picker: "lowest_roller" };

/** Issue #428: a live, carried-forward Last Cuppa immunity on `holder`. */
function lastCuppa(roomId: string, holder: string) {
  return {
    roomId,
    targetPlayerId: holder,
    casterId: holder,
    cardName: "The Last Cuppa",
    effectKind: "brewer_immunity",
    effectParams: { mode: "last_cuppa", persist: true, undispellable: true, override_proof: true },
    roundsRemaining: null,
  };
}

/** Issue #429: a live, carried-forward Earl of Earl Grey title on `holder`. */
function earl(roomId: string, holder: string) {
  return {
    roomId,
    targetPlayerId: holder,
    casterId: holder,
    cardName: "Earl of Earl Grey",
    effectKind: "brewer_immunity",
    effectParams: { mode: "earl", persist: true },
    roundsRemaining: null,
  };
}

/** Issue #431: a Loose Leaf armed by `holder` (its catalog row, migration 0135). */
function looseLeaf(ctx: ScenarioContext, roundId: string, holder: string) {
  return ctx.seedCast(roundId, holder, "Loose Leaf", {
    effectKind: "named_tea_maker_rolloff",
    effectParams: {},
    targetPlayerId: holder,
    extra: { target_role: "CASTER" },
  });
}

export const CORPUS: Scenario[] = [
  // =========================================================================
  // Phase 5 — brewer selection (default / override / declared)
  // =========================================================================
  {
    name: "05-default-pick-empty-trace",
    phases: ["5"],
    note: "A zero-cast round: lowest roll+modifier brews, Trace is empty.",
    async seed(ctx) {
      const p1 = await ctx.signUp("low");
      const p2 = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 4);
      await ctx.seedRoll(roundId, p2.googleSub, 17);
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-tea-maker-override-highest-roll",
    phases: ["5"],
    note: "tea_maker_override mode=highest_roll names the top roller regardless of totals.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("toproll");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 17);
      await ctx.seedCast(roundId, p1.googleSub, "Topsy-Tea", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "highest_roll" },
        targetPlayerId: null,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-tea-maker-override-highest-modifier-no-gain",
    phases: ["5"],
    note: "tea_maker_override mode=highest_modifier + no_modifier_gain picks the top snapshot and suppresses the gain.",
    async seed(ctx) {
      const p1 = await ctx.signUp("topmod");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5, 8);
      await ctx.seedRoll(roundId, p2.googleSub, 5, 2);
      await ctx.seedCast(roundId, p1.googleSub, "Drip Tray", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "highest_modifier", no_modifier_gain: true },
        targetPlayerId: null,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-tea-maker-override-prev-round-highest",
    phases: ["5"],
    note: "Last Drip (#426): tea_maker_override mode=prev_round_highest names the previous resolved round's top roller, with no modifier gain.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("prevwinner");
      // Last Drip reads the room's previous resolved round: a room of its own.
      const roomId = await ctx.seedDedicatedRoom([p1, p2]);
      await ctx.seedPastRound(roomId, [
        { playerId: p1.googleSub, value: 4 },
        { playerId: p2.googleSub, value: 18 },
      ]);
      const roundId = await ctx.openAndCloseRound(p1, [p2], roomId);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 16);
      await ctx.seedCast(roundId, p1.googleSub, "Last Drip", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "prev_round_highest", modifier_gain: 0 },
        targetPlayerId: null,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-tea-maker-override-prev-round-highest-inert",
    phases: ["5"],
    note: "Last Drip (#426): the previous winner isn't in this round, so a no-op step with override_reason target_absent, and the default pick stands.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("low");
      const absent = await ctx.signUp("absent");
      // absent: in the room and the previous round, not this one.
      const roomId = await ctx.seedDedicatedRoom([p1, p2, absent]);
      await ctx.seedPastRound(roomId, [
        { playerId: p1.googleSub, value: 4 },
        { playerId: absent.googleSub, value: 19 },
      ]);
      const roundId = await ctx.openAndCloseRound(p1, [p2], roomId);
      await ctx.seedRoll(roundId, p1.googleSub, 12);
      await ctx.seedRoll(roundId, p2.googleSub, 3);
      await ctx.seedCast(roundId, p1.googleSub, "Last Drip", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "prev_round_highest", modifier_gain: 0 },
        targetPlayerId: null,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-declared-number-tea-maker",
    phases: ["5"],
    note: "declared_number_tea_maker names the first roller matching the declared number, beating an override.",
    async seed(ctx) {
      const p1 = await ctx.signUp("declarer");
      const p2 = await ctx.signUp("match13");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 13);
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p1.googleSub,
        casterId: p1.googleSub,
        cardName: "Inscribed Saucer",
        effectKind: "declared_number_tea_maker",
        effectParams: { number: 13 },
        roundsRemaining: 1,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-pg-tipped-condition-met",
    phases: ["5"],
    note: "PG Tipped (#427) — conditional_chosen, target rolled below the caster: the target brews with no modifier gain over the default lowest.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const target = await ctx.signUp("target");
      const low = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(caster, [target, low]);
      await ctx.seedRoll(roundId, caster.googleSub, 15);
      await ctx.seedRoll(roundId, target.googleSub, 8);
      await ctx.seedRoll(roundId, low.googleSub, 2);
      await ctx.seedCast(roundId, caster.googleSub, "PG Tipped", {
        effectKind: "tea_maker_override",
        effectParams: PG_TIPPED,
        targetPlayerId: target.googleSub,
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  {
    name: "05-pg-tipped-condition-not-met",
    phases: ["5"],
    note: "PG Tipped (#427) — target rolled equal to the caster: a 'condition not met' no-op step, and the default lowest brews.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const target = await ctx.signUp("target");
      const low = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(caster, [target, low]);
      await ctx.seedRoll(roundId, caster.googleSub, 10);
      await ctx.seedRoll(roundId, target.googleSub, 10);
      await ctx.seedRoll(roundId, low.googleSub, 2);
      await ctx.seedCast(roundId, caster.googleSub, "PG Tipped", {
        effectKind: "tea_maker_override",
        effectParams: PG_TIPPED,
        targetPlayerId: target.googleSub,
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  {
    name: "05-pg-tipped-not-met-earlier-override-stands",
    phases: ["5"],
    note: "PG Tipped (#427) cast last but its condition fails: it never enters the last-cast-wins contest, so an earlier chosen override still names the brewer.",
    async seed(ctx) {
      const chooser = await ctx.signUp("chooser");
      const pg = await ctx.signUp("pg-caster");
      const chosen = await ctx.signUp("chosen");
      const target = await ctx.signUp("pg-target");
      const roundId = await ctx.openAndCloseRound(chooser, [pg, chosen, target]);
      await ctx.seedRoll(roundId, chooser.googleSub, 3);
      await ctx.seedRoll(roundId, pg.googleSub, 6);
      await ctx.seedRoll(roundId, chosen.googleSub, 18);
      await ctx.seedRoll(roundId, target.googleSub, 12);
      await ctx.seedCast(roundId, chooser.googleSub, "Wild Brew Surge", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen" },
        targetPlayerId: chosen.googleSub,
        extra: { cast_at: new Date(Date.now() - 60_000).toISOString() },
      });
      await ctx.seedCast(roundId, pg.googleSub, "PG Tipped", {
        effectKind: "tea_maker_override",
        effectParams: PG_TIPPED,
        targetPlayerId: target.googleSub,
      });
      return { roundId, resolveWith: chooser.client };
    },
  },
  {
    name: "05-tea-party-revolt-picked",
    phases: ["5"],
    note: "Tea Party Revolt (#430) — the lowest roller picked the top roller, who brews; the step names the picker.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const low = await ctx.signUp("low");
      const high = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(caster, [low, high]);
      await ctx.seedRoll(roundId, caster.googleSub, 11);
      await ctx.seedRoll(roundId, low.googleSub, 3);
      await ctx.seedRoll(roundId, high.googleSub, 18);
      await ctx.seedCast(roundId, caster.googleSub, "Tea Party Revolt", {
        effectKind: "tea_maker_override",
        effectParams: TEA_PARTY_REVOLT,
        targetPlayerId: high.googleSub,
        castInputs: { revolt_picked_by: low.googleSub },
        extra: { target_role: "TABLE" },
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  {
    name: "05-tea-party-revolt-pick-abandoned",
    phases: ["5"],
    note: "Tea Party Revolt (#430) — stall abandoned the pick: a 'pick_abandoned' no-op step, and the default lowest brews.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const low = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(caster, [low]);
      await ctx.seedRoll(roundId, caster.googleSub, 11);
      await ctx.seedRoll(roundId, low.googleSub, 3);
      await ctx.seedCast(roundId, caster.googleSub, "Tea Party Revolt", {
        effectKind: "tea_maker_override",
        effectParams: TEA_PARTY_REVOLT,
        targetPlayerId: null,
        castInputs: { revolt_pick_abandoned: true },
        extra: { target_role: "TABLE", negated: true },
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  {
    name: "05-tea-party-revolt-abandoned-earlier-override-stands",
    phases: ["5"],
    note: "Tea Party Revolt (#430) cast last but its pick was abandoned: it never enters the last-cast-wins contest, so an earlier chosen override still names the brewer.",
    async seed(ctx) {
      const chooser = await ctx.signUp("chooser");
      const revolter = await ctx.signUp("revolter");
      const chosen = await ctx.signUp("chosen");
      const roundId = await ctx.openAndCloseRound(chooser, [revolter, chosen]);
      await ctx.seedRoll(roundId, chooser.googleSub, 3);
      await ctx.seedRoll(roundId, revolter.googleSub, 9);
      await ctx.seedRoll(roundId, chosen.googleSub, 18);
      await ctx.seedCast(roundId, chooser.googleSub, "Wild Brew Surge", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen" },
        targetPlayerId: chosen.googleSub,
        extra: { cast_at: new Date(Date.now() - 60_000).toISOString() },
      });
      await ctx.seedCast(roundId, revolter.googleSub, "Tea Party Revolt", {
        effectKind: "tea_maker_override",
        effectParams: TEA_PARTY_REVOLT,
        targetPlayerId: null,
        castInputs: { revolt_pick_abandoned: true },
        extra: { target_role: "TABLE", negated: true },
      });
      return { roundId, resolveWith: chooser.client };
    },
  },
  {
    name: "05-pg-tipped-compares-post-shim-rolls",
    phases: ["3", "5"],
    note: "PG Tipped (#427) compares the rolls after the roll-input shim: the target's raw 15 is flipped to 6, below the caster's 9, so the target brews.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const target = await ctx.signUp("target");
      const low = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(caster, [target, low]);
      await ctx.seedRoll(roundId, caster.googleSub, 9);
      await ctx.seedRoll(roundId, target.googleSub, 15);
      await ctx.seedRoll(roundId, low.googleSub, 2);
      await ctx.seedCast(roundId, caster.googleSub, "PG Tipped", {
        effectKind: "tea_maker_override",
        effectParams: PG_TIPPED,
        targetPlayerId: target.googleSub,
      });
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, low.googleSub, "Zariel's Fall", {
        effectKind: "roll_flip",
        effectParams: {},
        targetPlayerId: target.googleSub,
        reactionWindowId: win,
        castInputs: ctx.rollTransform("roll_flip", 1, [
          { player_id: target.googleSub, before: 15, after: 6 },
        ]),
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  {
    name: "05-pg-tipped-redirected-onto-caster",
    phases: ["1", "5"],
    note: "PG Tipped (#427) redirected back onto its caster: Phase 5 reads the redirect, the caster can't roll below themselves, so the condition fails and the default lowest brews.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const target = await ctx.signUp("redirector");
      const low = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(caster, [target, low]);
      await ctx.seedRoll(roundId, caster.googleSub, 15);
      await ctx.seedRoll(roundId, target.googleSub, 8);
      await ctx.seedRoll(roundId, low.googleSub, 2);
      const { castId: pgId } = await ctx.seedCast(roundId, caster.googleSub, "PG Tipped", {
        effectKind: "tea_maker_override",
        effectParams: PG_TIPPED,
        targetPlayerId: target.googleSub,
      });
      await ctx.seedCast(roundId, target.googleSub, "Kettle Storm", {
        effectKind: "redirect",
        effectParams: {},
        targetPlayerId: null,
        parentCastId: pgId,
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  // Issue #428: brewer immunity (ADR 0005 tier 0) skips an immune player
  // inside every Phase 5 tier.
  {
    name: "05-brewer-immunity-lowest-roller",
    phases: ["5"],
    note: "An immune lowest roller (The Last Cuppa) is passed over; the next-lowest brews.",
    async seed(ctx) {
      const p1 = await ctx.signUp("immune-low");
      const p2 = await ctx.signUp("next-low");
      const p3 = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 2);
      await ctx.seedRoll(roundId, p2.googleSub, 8);
      await ctx.seedRoll(roundId, p3.googleSub, 16);
      await ctx.seedActiveEffect(lastCuppa(p1.roomId, p1.googleSub));
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-brewer-immunity-declared-number",
    phases: ["5"],
    note: "A declared number rolled only by an immune player is no match; the default pick brews.",
    async seed(ctx) {
      const p1 = await ctx.signUp("immune-13");
      const p2 = await ctx.signUp("declarer");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 13);
      await ctx.seedRoll(roundId, p2.googleSub, 15);
      await ctx.seedActiveEffect(lastCuppa(p1.roomId, p1.googleSub));
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p2.googleSub,
        casterId: p2.googleSub,
        cardName: "Inscribed Saucer",
        effectKind: "declared_number_tea_maker",
        effectParams: { number: 13 },
        roundsRemaining: 1,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-brewer-immunity-override-falls-through",
    phases: ["5"],
    note: "A chosen tea_maker_override naming an immune player falls through to the default pick.",
    async seed(ctx) {
      const p1 = await ctx.signUp("immune-target");
      const p2 = await ctx.signUp("caster");
      const p3 = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 17);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedRoll(roundId, p3.googleSub, 5);
      await ctx.seedActiveEffect(lastCuppa(p1.roomId, p1.googleSub));
      await ctx.seedCast(roundId, p2.googleSub, "Drip Tray", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen" },
        targetPlayerId: p1.googleSub,
      });
      return { roundId, resolveWith: p2.client };
    },
  },
  {
    name: "05-brewer-immunity-all-immune-tie",
    phases: ["5"],
    note: "Everyone immune and no override: immunity gives way to a tie across all participants.",
    async seed(ctx) {
      const p1 = await ctx.signUp("immune-a");
      const p2 = await ctx.signUp("immune-b");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 4);
      await ctx.seedRoll(roundId, p2.googleSub, 11);
      await ctx.seedActiveEffect(lastCuppa(p1.roomId, p1.googleSub));
      await ctx.seedActiveEffect(lastCuppa(p1.roomId, p2.googleSub));
      return { roundId, resolveWith: p1.client };
    },
  },
  // Issue #429: Earl of Earl Grey -- immune like anyone, except a force on the
  // Earl passes the title to the forcing card's caster and the ex-Earl brews.
  {
    name: "05-earl-lowest-roller-next-lowest-brews",
    phases: ["5"],
    note: "The Earl rolls lowest and is passed over; the next-lowest roller brews.",
    async seed(ctx) {
      const p1 = await ctx.signUp("earl");
      const p2 = await ctx.signUp("next-low");
      const p3 = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 3);
      await ctx.seedRoll(roundId, p2.googleSub, 7);
      await ctx.seedRoll(roundId, p3.googleSub, 18);
      await ctx.seedActiveEffect(earl(p1.roomId, p1.googleSub));
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-earl-override-transfers-title",
    phases: ["5"],
    note: "A chosen override naming the Earl passes the title to its caster first; the ex-Earl brews.",
    async seed(ctx) {
      const p1 = await ctx.signUp("earl");
      const p2 = await ctx.signUp("caster");
      const p3 = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 17);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedRoll(roundId, p3.googleSub, 5);
      await ctx.seedActiveEffect(earl(p1.roomId, p1.googleSub));
      await ctx.seedCast(roundId, p2.googleSub, "Drip Tray", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen" },
        targetPlayerId: p1.googleSub,
      });
      return { roundId, resolveWith: p2.client };
    },
  },
  {
    name: "05-earl-declared-number-no-transfer",
    phases: ["5"],
    note: "A declared number the Earl rolled is a plain immunity skip -- no title transfer.",
    async seed(ctx) {
      const p1 = await ctx.signUp("earl-13");
      const p2 = await ctx.signUp("declarer");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 13);
      await ctx.seedRoll(roundId, p2.googleSub, 15);
      await ctx.seedActiveEffect(earl(p1.roomId, p1.googleSub));
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p2.googleSub,
        casterId: p2.googleSub,
        cardName: "Inscribed Saucer",
        effectKind: "declared_number_tea_maker",
        effectParams: { number: 13 },
        roundsRemaining: 1,
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 4a — modifier-bucket composition (flat / set / multiplier)
  // =========================================================================
  {
    name: "4a-flat-modifier-self-buff",
    phases: ["4a", "5"],
    note: "flat_modifier +3 on the caster composes into the pick as one Trace step.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 10);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedCast(roundId, p1.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 3 },
        targetPlayerId: p1.googleSub,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    // Issue #406: roll-time totals (10 vs 12) don't tie; the composed ones do.
    // The Reroll Chain must read this tie from layer 1's participants, since
    // re-judging it on roll-time modifiers would miss it.
    name: "4a-spell-modifier-creates-layer0-tie",
    phases: ["4a", "5"],
    note: "A flat +2 lifts the lowest roller onto the next roller's total: layer 0 ties on composed modifiers, not roll-time ones.",
    async seed(ctx) {
      const p1 = await ctx.signUp("lifted");
      const p2 = await ctx.signUp("level");
      const p3 = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 10);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedRoll(roundId, p3.googleSub, 18);
      await ctx.seedCast(roundId, p3.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 2 },
        targetPlayerId: p1.googleSub,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "4a-set-modifier-overrides-sibling-flat",
    phases: ["4a", "5"],
    note: "set_modifier is absolute — it ignores a sibling flat effect; two sets resolve to the last by seq.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5, 10);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedCast(roundId, p1.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 4 },
        targetPlayerId: p1.googleSub,
      });
      await ctx.seedCast(roundId, p1.googleSub, "Milky Brew", {
        effectKind: "set_modifier",
        effectParams: { value: 0 },
        targetPlayerId: p1.googleSub,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "4a-modifier-multiplier-scales-snapshot",
    phases: ["4a", "5"],
    note: "modifier_multiplier x2 scales the persistent snapshot, not the roll.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 6, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 13);
      await ctx.seedCast(roundId, p1.googleSub, "Double Shot", {
        effectKind: "modifier_multiplier",
        effectParams: { multiplier: 2 },
        targetPlayerId: p1.googleSub,
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 4c — lowest_gains_highest_modifier (Broken Biscuit)
  // =========================================================================
  {
    name: "4c-lowest-gains-highest-modifier",
    phases: ["4a", "4c", "5"],
    note: "Broken Biscuit lifts the lowest roller's composed modifier to the highest roller's.",
    async seed(ctx) {
      const p1 = await ctx.signUp("lowest");
      const p2 = await ctx.signUp("highroll");
      const p3 = await ctx.signUp("mid");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 2);
      await ctx.seedRoll(roundId, p2.googleSub, 18);
      await ctx.seedRoll(roundId, p3.googleSub, 3);
      await ctx.seedCast(roundId, p2.googleSub, "Brewer's Blessing", {
        effectKind: "flat_modifier",
        effectParams: { delta: 5 },
        targetPlayerId: p2.googleSub,
      });
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p3.googleSub, "Broken Biscuit", {
        effectKind: "lowest_gains_highest_modifier",
        effectParams: {},
        targetPlayerId: null,
        reactionWindowId: win,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "4c-targeting-skip-excludes-holder",
    phases: ["4c", "5"],
    note: "targeting_skip (Cloud of Cream) drops the holder from lowest_gains_highest_modifier on both sides.",
    async seed(ctx) {
      const p1 = await ctx.signUp("skip-holder");
      const p2 = await ctx.signUp("highroll");
      const p3 = await ctx.signUp("caster");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 2);
      await ctx.seedRoll(roundId, p2.googleSub, 18, 6);
      await ctx.seedRoll(roundId, p3.googleSub, 4);
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p1.googleSub,
        casterId: p1.googleSub,
        cardName: "Cloud of Cream",
        effectKind: "targeting_skip",
        effectParams: {},
        roundsRemaining: 2,
      });
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p3.googleSub, "Broken Biscuit", {
        effectKind: "lowest_gains_highest_modifier",
        effectParams: {},
        targetPlayerId: null,
        reactionWindowId: win,
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 1 — Cast-Log resolution (negate / redirect / backfire chains)
  // =========================================================================
  {
    name: "1-contested-negate-succeeds",
    phases: ["1", "5"],
    note: "A succeeded contested_negate suppresses the whole victim cast group and marks it negated.",
    async seed(ctx) {
      const p1 = await ctx.signUp("victim");
      const p2 = await ctx.signUp("counter");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      const { castId: victimId } = await ctx.seedCast(roundId, p1.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 10 },
        targetPlayerId: p1.googleSub,
      });
      await ctx.seedCast(roundId, p2.googleSub, "Tannin Tantrum", {
        effectKind: "contested_negate",
        effectParams: {},
        targetPlayerId: null,
        parentCastId: victimId,
        castInputs: { dc_d20: 15 },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "1-contested-negate-fails-is-noop-step",
    phases: ["1", "4a", "5"],
    note: "A failed contested_negate leaves the victim cast to compose and reads as a no-op step.",
    async seed(ctx) {
      const p1 = await ctx.signUp("victim");
      const p2 = await ctx.signUp("counter");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      const { castId: victimId } = await ctx.seedCast(roundId, p1.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 4 },
        targetPlayerId: p1.googleSub,
      });
      await ctx.seedCast(roundId, p2.googleSub, "Tannin Tantrum", {
        effectKind: "contested_negate",
        effectParams: { dc: 10 },
        targetPlayerId: null,
        parentCastId: victimId,
        castInputs: { dc_d20: 3, dc: 10 },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "1-counter-of-counter-depth-2",
    phases: ["1", "4a", "5"],
    note: "Counter-of-counter: C2 negates C1, so the original victim flat_modifier applies.",
    async seed(ctx) {
      const p1 = await ctx.signUp("victim");
      const p2 = await ctx.signUp("c1");
      const p3 = await ctx.signUp("c2");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedRoll(roundId, p3.googleSub, 13);
      const { castId: victimId } = await ctx.seedCast(roundId, p1.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 10 },
        targetPlayerId: p1.googleSub,
      });
      const { castId: c1 } = await ctx.seedCast(roundId, p2.googleSub, "Tannin Tantrum", {
        effectKind: "contested_negate",
        effectParams: {},
        targetPlayerId: null,
        parentCastId: victimId,
        castInputs: { dc_d20: 15 },
      });
      await ctx.seedCast(roundId, p3.googleSub, "Tannin Tantrum", {
        effectKind: "contested_negate",
        effectParams: {},
        targetPlayerId: null,
        parentCastId: c1,
        castInputs: { dc_d20: 15 },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "1-redirect-retargets-modifier-cast",
    phases: ["1", "4a", "5"],
    note: "redirect moves a countered set_modifier onto the redirector's own caster, from recorded state.",
    async seed(ctx) {
      const p1 = await ctx.signUp("orig-target");
      const p2 = await ctx.signUp("redirector");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 8);
      await ctx.seedRoll(roundId, p2.googleSub, 8);
      const { castId: victimId } = await ctx.seedCast(roundId, p1.googleSub, "Mug Shot", {
        effectKind: "set_modifier",
        effectParams: { value: 100 },
        targetPlayerId: p2.googleSub,
      });
      await ctx.seedCast(roundId, p2.googleSub, "Kettle Storm", {
        effectKind: "redirect",
        effectParams: {},
        targetPlayerId: null,
        parentCastId: victimId,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "1-nat1-backfire-reapplies-onto-reactor",
    phases: ["1", "4a", "5"],
    note: "A nat-1 backfire leaves the victim to resolve and re-applies its flat_modifier onto the reactor, outcome backfired.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("reactor");
      const p3 = await ctx.signUp("victim-target");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 9);
      await ctx.seedRoll(roundId, p2.googleSub, 9);
      await ctx.seedRoll(roundId, p3.googleSub, 9);
      const { castId: victimId } = await ctx.seedCast(roundId, p1.googleSub, "Kettle Storm", {
        effectKind: "flat_modifier",
        effectParams: { delta: 10 },
        targetPlayerId: p3.googleSub,
      });
      await ctx.seedCast(roundId, p2.googleSub, "Saving Steep", {
        effectKind: "contested_negate",
        effectParams: { dc: 10, backfire: true },
        targetPlayerId: null,
        parentCastId: victimId,
        castInputs: { dc_d20: 1, dc: 10 },
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 3 — roll-input accounting (eager-shim transforms)
  // =========================================================================
  {
    name: "3-roll-flip-then-swap",
    phases: ["3", "5"],
    note: "Phase 3 adopts the eager shim's recorded transforms in order: flip (order 3) before swap (order 4).",
    async seed(ctx) {
      const p1 = await ctx.signUp("p1");
      const p2 = await ctx.signUp("p2");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 2);
      await ctx.seedRoll(roundId, p2.googleSub, 19);
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p2.googleSub, "Zariel's Fall", {
        effectKind: "roll_flip",
        effectParams: {},
        targetPlayerId: null,
        reactionWindowId: win,
        castInputs: ctx.rollTransform("roll_flip", 3, [
          { player_id: p1.googleSub, before: 2, after: 19 },
          { player_id: p2.googleSub, before: 19, after: 2 },
        ]),
      });
      await ctx.seedCast(roundId, p2.googleSub, "Dunkin Disaster", {
        effectKind: "roll_swap",
        effectParams: {},
        targetPlayerId: null,
        reactionWindowId: win,
        castInputs: ctx.rollTransform("roll_swap", 4, [
          { player_id: p1.googleSub, before: 19, after: 2 },
          { player_id: p2.googleSub, before: 2, after: 19 },
        ]),
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "3-forced-reroll-adopted",
    phases: ["3", "5"],
    note: "Phase 3 reproduces the final roll purely from the recorded forced_reroll roll_transform.",
    async seed(ctx) {
      const p1 = await ctx.signUp("rerolled");
      const p2 = await ctx.signUp("forcer");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 18);
      await ctx.seedRoll(roundId, p2.googleSub, 9);
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p2.googleSub, "Double Dunk", {
        effectKind: "forced_reroll",
        effectParams: {},
        targetPlayerId: p1.googleSub,
        reactionWindowId: win,
        castInputs: ctx.rollTransform("forced_reroll", 2, [{ player_id: p1.googleSub, before: 18, after: 2 }]),
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "3-advantage-adopts-kept-high-die",
    phases: ["3", "5"],
    note: "advantage (Sugar Rush) — the resolver adopts the shim's kept high die.",
    async seed(ctx) {
      const p1 = await ctx.signUp("advantaged");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 3);
      await ctx.seedRoll(roundId, p2.googleSub, 8);
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p1.googleSub, "Sugar Rush", {
        effectKind: "advantage",
        effectParams: {},
        targetPlayerId: p1.googleSub,
        reactionWindowId: win,
        castInputs: ctx.rollTransform("advantage", 1, [{ player_id: p1.googleSub, before: 3, after: 19 }], {
          cancelled: false,
          dice: [3, 19],
        }),
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "3-fixed-roll-pre-roll-kind",
    phases: ["3", "5"],
    note: "fixed_roll (Steady Hand) is a pre-roll transform at order 0 the resolver adopts.",
    async seed(ctx) {
      const p1 = await ctx.signUp("fixed");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 11);
      await ctx.seedRoll(roundId, p2.googleSub, 7);
      await ctx.seedCast(roundId, p1.googleSub, "Steady Hand", {
        effectKind: "fixed_roll",
        effectParams: { value: 1 },
        targetPlayerId: p1.googleSub,
        castInputs: ctx.rollTransform("fixed_roll", 0, [{ player_id: p1.googleSub, before: 11, after: 1 }]),
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "3-roll-pair-transform-swap",
    phases: ["3", "5"],
    note: "roll_pair_transform op=swap exchanges the two named rollers' values; the resolver adopts them.",
    async seed(ctx) {
      const p1 = await ctx.signUp("a");
      const p2 = await ctx.signUp("b");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 4);
      await ctx.seedRoll(roundId, p2.googleSub, 17);
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p1.googleSub, "Brew-tal Swap", {
        effectKind: "roll_pair_transform",
        effectParams: { op: "swap" },
        targetPlayerId: null,
        reactionWindowId: win,
        extra: { target_role: "TABLE" },
        castInputs: ctx.rollTransform("roll_pair_transform", 5, [
          { player_id: p1.googleSub, before: 4, after: 17 },
          { player_id: p2.googleSub, before: 17, after: 4 },
        ], { op: "swap" }),
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "3-conditional-advantage-branch-advantage",
    phases: ["3", "5"],
    note: "Gambler's Infusion — first die >= 15 selects the advantage branch; the resolver adopts the high die.",
    async seed(ctx) {
      const p1 = await ctx.signUp("gambler");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 17);
      await ctx.seedRoll(roundId, p2.googleSub, 8);
      await ctx.seedCast(roundId, p1.googleSub, "Gambler's Infusion", {
        effectKind: "advantage",
        effectParams: GAMBLER_CONDITION,
        targetPlayerId: p1.googleSub,
        castInputs: {
          roll_transform: {
            kind: "advantage",
            order: 1,
            cancelled: false,
            condition: { first_die: 17, branch: "advantage", advantage_at_or_above: 15, disadvantage_at_or_below: 5 },
            dice: [17, 19],
            players: [{ player_id: p1.googleSub, before: 17, after: 19 }],
          },
        },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "3-conditional-advantage-branch-none-noop",
    phases: ["3", "5"],
    note: "Gambler's Infusion — first die between the thresholds is a kept zero-impact conditional_advantage step.",
    async seed(ctx) {
      const p1 = await ctx.signUp("gambler");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 9);
      await ctx.seedRoll(roundId, p2.googleSub, 3);
      await ctx.seedCast(roundId, p1.googleSub, "Gambler's Infusion", {
        effectKind: "advantage",
        effectParams: GAMBLER_CONDITION,
        targetPlayerId: p1.googleSub,
        castInputs: {
          roll_transform: {
            kind: "advantage",
            order: 1,
            cancelled: false,
            condition: { first_die: 9, branch: "none", advantage_at_or_above: 15, disadvantage_at_or_below: 5 },
            dice: [9],
            players: [{ player_id: p1.googleSub, before: 9, after: 9 }],
          },
        },
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 2 — ward projection (polarity × domain immunity)
  // =========================================================================
  {
    name: "2-ward-blocks-modifier-cast",
    phases: ["2", "5"],
    note: "A positive-polarity modifier ward (Jinxed Biscuit) blocks a positive flat_modifier: a warded/blocked step, no composed step.",
    async seed(ctx) {
      const p1 = await ctx.signUp("warded");
      const p2 = await ctx.signUp("caster");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedCast(roundId, p2.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 10 },
        targetPlayerId: p1.googleSub,
      });
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p1.googleSub,
        casterId: p2.googleSub,
        cardName: "Jinxed Biscuit",
        effectKind: "ward",
        effectParams: { polarity: ["positive"], domain: ["modifier", "roll"] },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "2-ward-blocks-roll-transform",
    phases: ["2", "5"],
    note: "A negative-polarity roll ward (Cast-Iron Kettle) blocks a forced_reroll aimed at the holder.",
    async seed(ctx) {
      const p1 = await ctx.signUp("warded");
      const p2 = await ctx.signUp("forcer");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 16);
      await ctx.seedRoll(roundId, p2.googleSub, 9);
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p2.googleSub, "Double Dunk", {
        effectKind: "forced_reroll",
        effectParams: {},
        targetPlayerId: p1.googleSub,
        reactionWindowId: win,
        castInputs: ctx.rollTransform("forced_reroll", 2, [
          { player_id: p1.googleSub, before: 16, after: 2, warded: true },
        ]),
      });
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p1.googleSub,
        casterId: p1.googleSub,
        cardName: "Cast-Iron Kettle",
        effectKind: "ward",
        effectParams: { polarity: ["negative"], domain: ["roll"] },
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 0a / 0b — Effect Invocation (Saucerer's Apprentice copy)
  // =========================================================================
  {
    name: "0-spell-copy-onto-apprentice-caster",
    phases: ["0a", "0b", "4a", "5"],
    note: "Saucerer's Apprentice copies a stack flat_modifier onto its own caster; the original still resolves.",
    async seed(ctx) {
      const p1 = await ctx.signUp("resolver");
      const p2 = await ctx.signUp("src-caster");
      const p3 = await ctx.signUp("apprentice");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 10);
      await ctx.seedRoll(roundId, p2.googleSub, 10);
      await ctx.seedRoll(roundId, p3.googleSub, 10);
      const win = await ctx.openWindow(roundId);
      const { castId: srcCast } = await ctx.seedCast(roundId, p2.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 6 },
        targetPlayerId: p2.googleSub,
        reactionWindowId: win,
        extra: { target_role: "TARGET" },
      });
      await ctx.seedCast(roundId, p3.googleSub, "Saucerer's Apprentice", {
        effectKind: null as unknown as string,
        effectParams: {},
        targetPlayerId: null,
        reactionWindowId: win,
        parentCastId: srcCast,
        extra: { target_role: "CARD" },
        castInputs: { copied_cast_id: srcCast, copy_inputs: {} },
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 4b — persistent modifier delta projection (rest-of-day transfers)
  // =========================================================================
  {
    name: "4b-persistent-modifier-transfer-rest-of-day",
    phases: ["4b", "5"],
    note: "A one-sided persistent_modifier_transfer (+3 caster, rest of day) projects into room_players.modifier at resolve.",
    async seed(ctx) {
      const p1 = await ctx.signUp("beneficiary");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 9);
      await ctx.seedRoll(roundId, p2.googleSub, 10);
      await ctx.seedCast(roundId, p1.googleSub, "Chai-nge of Heart", {
        effectKind: "persistent_modifier_transfer",
        effectParams: { delta: 3 },
        targetPlayerId: p1.googleSub,
        extra: { source_cast_id: null },
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 4b-pre — Bitter Leech per-round tick synthesis
  // =========================================================================
  {
    name: "4b-pre-bitter-leech-tick-synthesis",
    phases: ["4b-pre", "4b", "5"],
    note: "A live Bitter Leech persistent_modifier_transfer with per_round_delta synthesises a -1/+1 tick pair into this round's Cast Log.",
    async seed(ctx) {
      const p1 = await ctx.signUp("leech-caster");
      const p2 = await ctx.signUp("leech-victim");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 10);
      await ctx.seedRoll(roundId, p2.googleSub, 11);
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p2.googleSub,
        casterId: p1.googleSub,
        cardName: "Bitter Leech",
        effectKind: "persistent_modifier_transfer",
        effectParams: { per_round_delta: 1 },
        roundsRemaining: 3,
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 3-pre — Calami-Tea per-round dice tick synthesis
  // =========================================================================
  {
    name: "3-pre-calami-tea-tick-warded",
    phases: ["3-pre", "2", "5"],
    // Phase 3-pre inserts the synthesised tick row and emits its warded step
    // only on the generation's first resolve; a re-resolve finds the row and
    // skips both. The golden is therefore the first-resolve Trace.
    nonIdempotent: true,
    note: "A negative roll-domain ward on a Calami-Tea target blocks the synthesised per-round die tick; a warded step is emitted in Phase 3-pre (its RNG die is redacted).",
    async seed(ctx) {
      const p1 = await ctx.signUp("calami-target");
      const p2 = await ctx.signUp("calami-caster");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 12);
      await ctx.seedRoll(roundId, p2.googleSub, 13);
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p1.googleSub,
        casterId: p2.googleSub,
        cardName: "Calami-Tea",
        effectKind: "per_round_dice_tick",
        effectParams: { die: 4, sign: -1 },
        roundsRemaining: 3,
      });
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p1.googleSub,
        casterId: p1.googleSub,
        cardName: "Cast-Iron Kettle",
        effectKind: "ward",
        effectParams: { polarity: ["negative"], domain: ["roll"] },
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  {
    // Issue #407: a roll of 2 minus any 1d4 floors at 1 — deterministic
    // despite the resolve-time die. The floored 1 is not a natural 1
    // (dice_reduced), so it doesn't auto-brew: the 2 - 2 = 0 roller does.
    name: "3-calami-tea-floored-natural-1",
    phases: ["3", "5"],
    dryRunDiffers: "the dry run never rolls the Calami-Tea tick die, so the 2 stays a 2",
    note: "A Calami-Tea tick drags a 2 down to the floor of 1; the summary marks it dice_reduced with no nat-1 standing, and the lowest total brews.",
    async seed(ctx) {
      const p1 = await ctx.signUp("floored");
      const p2 = await ctx.signUp("low-total");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 2);
      await ctx.seedRoll(roundId, p2.googleSub, 2, -2);
      await ctx.seedActiveEffect({
        roomId: p1.roomId,
        targetPlayerId: p1.googleSub,
        casterId: p2.googleSub,
        cardName: "Calami-Tea",
        effectKind: "per_round_dice_tick",
        effectParams: { die: 4, sign: -1 },
        roundsRemaining: 3,
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Round replay (Time for Brew) — issue #408
  // =========================================================================
  {
    // Generation 0 resolves with a +3 on `buffed`, is scrapped by a confirmed
    // Time for Brew, and generation 1 rolls fresh with a +6. The golden's
    // scrappedGenerations block pins generation 0's OWN summary (the +3), so
    // its disclosure rows can never show generation 1's numbers.
    name: "5-replay-scrapped-generation-summary",
    phases: ["4a", "5"],
    note: "A replayed round: the scrapped generation carries its own Resolution Summary, distinct from generation 1's.",
    async seed(ctx) {
      const p1 = await ctx.signUp("buffed");
      const p2 = await ctx.signUp("plain");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedCast(roundId, p2.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 3 },
        targetPlayerId: p1.googleSub,
      });
      await ctx.seedCast(roundId, p1.googleSub, "Time for Brew", {
        effectKind: "round_replay",
        effectParams: {},
        targetPlayerId: null,
      });
      const { error: e0 } = await p1.client.rpc("resolve_round", { p_round_id: roundId });
      if (e0) throw e0;
      const { error: e1 } = await p1.client.rpc("resolve_round", {
        p_round_id: roundId,
        p_brewer_id: p1.googleSub,
        p_cups_made: 2,
      });
      if (e1) throw e1;
      const { error: e2 } = await p1.client.rpc("record_pending_round_replay", { p_round_id: roundId });
      if (e2) throw e2;
      const { error: e3 } = await p1.client.rpc("confirm_round_replay", { p_round_id: roundId });
      if (e3) throw e3;

      // generation 1
      await ctx.seedRoll(roundId, p1.googleSub, 9);
      await ctx.seedRoll(roundId, p2.googleSub, 11);
      await ctx.seedCast(roundId, p2.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 6 },
        targetPlayerId: p1.googleSub,
        extra: { generation: 1 },
      });
      return { roundId, resolveWith: p1.client };
    },
  },

  // =========================================================================
  // Phase 6 — Tea Heist outcomes (issue #438). The resolver only traces the
  // Heist; finalize_layer moves the card, so resolve_round's Trace here is the
  // decision alone and stays identical across re-runs and the dry run.
  // =========================================================================
  {
    name: "6-heist-moved",
    phases: ["5", "6"],
    note: "An un-negated Tea Heist whose victim still holds the pinned card traces held -> moved.",
    async seed(ctx) {
      const thief = await ctx.signUp("thief");
      const victim = await ctx.signUp("victim");
      const roundId = await ctx.openAndCloseRound(thief, [victim]);
      await ctx.seedRoll(roundId, thief.googleSub, 5);
      await ctx.seedRoll(roundId, victim.googleSub, 12);
      const loot = await ctx.forceHold(victim.googleSub, "Lucky Sip");
      await ctx.seedCast(roundId, thief.googleSub, "Tea Heist", {
        effectKind: "card_heist",
        effectParams: {},
        targetPlayerId: victim.googleSub,
        castInputs: { stolen_instance_id: loot },
      });
      return { roundId, resolveWith: thief.client };
    },
  },
  // Issue #436: Marked for Brew. The mark is placed in its cast round and
  // fires at roll time (_apply_crit_redirect); the resolver's final phase
  // only traces what was recorded.
  {
    name: "6-marked-for-brew-placed",
    phases: ["5", "6"],
    note: "A Marked for Brew cast this round traces a `marked` draw_redirect step on its target.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const target = await ctx.signUp("target");
      const roundId = await ctx.openAndCloseRound(caster, [target]);
      await ctx.seedRoll(roundId, caster.googleSub, 5);
      await ctx.seedRoll(roundId, target.googleSub, 12);
      await ctx.seedCast(roundId, caster.googleSub, "Marked for Brew", {
        effectKind: "draw_redirect",
        effectParams: { trigger: "next_crit", persist: true, participated_rounds_after_cast: 5 },
        targetPlayerId: target.googleSub,
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  ...(["redirected", "fizzled"] as const).map(
    (outcome): Scenario => ({
      name: `6-marked-for-brew-${outcome}`,
      phases: ["5", "6"],
      note:
        outcome === "redirected"
          ? "An earlier round's mark fires on the target's nat 20: the draw goes to the caster (marked -> redirected)."
          : "The mark fires but the caster already has a pending draw this round, so it fizzles and the target keeps theirs (marked -> fizzled).",
      async seed(ctx) {
        const caster = await ctx.signUp("caster");
        const target = await ctx.signUp("target");
        const castRound = await ctx.seedPastRound(target.roomId, [
          { playerId: caster.googleSub, value: 9 },
          { playerId: target.googleSub, value: 11 },
        ]);
        await ctx.seedActiveEffect({
          roomId: target.roomId,
          targetPlayerId: target.googleSub,
          casterId: caster.googleSub,
          cardName: "Marked for Brew",
          effectKind: "draw_redirect",
          effectParams: { trigger: "next_crit", persist: true, participated_rounds_after_cast: 5 },
          roundId: castRound,
        });
        const roundId = await ctx.openAndCloseRound(caster, [target]);
        if (outcome === "fizzled") {
          const { error } = await caster.client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat1" });
          if (error) throw error;
        }
        const { error } = await target.client.rpc("record_pending_spell_draw", { p_round_id: roundId, p_trigger: "nat20" });
        if (error) throw error;
        await ctx.seedRoll(roundId, caster.googleSub, outcome === "fizzled" ? 1 : 5);
        await ctx.seedRoll(roundId, target.googleSub, 20);
        return { roundId, resolveWith: caster.client };
      },
    }),
  ),
  {
    // Tea Heist is rare: tier DC 5, so dc_d20 15 succeeds.
    name: "6-heist-countered",
    phases: ["1", "5", "6"],
    note: "A countered Tea Heist traces held -> countered after Phase 1's negated-victim step; nothing moves.",
    async seed(ctx) {
      const thief = await ctx.signUp("thief");
      const victim = await ctx.signUp("victim");
      const counter = await ctx.signUp("counter");
      const roundId = await ctx.openAndCloseRound(thief, [victim, counter]);
      await ctx.seedRoll(roundId, thief.googleSub, 5);
      await ctx.seedRoll(roundId, victim.googleSub, 12);
      await ctx.seedRoll(roundId, counter.googleSub, 14);
      const loot = await ctx.forceHold(victim.googleSub, "Lucky Sip");
      const { castId: heist } = await ctx.seedCast(roundId, thief.googleSub, "Tea Heist", {
        effectKind: "card_heist",
        effectParams: {},
        targetPlayerId: victim.googleSub,
        castInputs: { stolen_instance_id: loot },
      });
      await ctx.seedCast(roundId, counter.googleSub, "Tannin Tantrum", {
        effectKind: "contested_negate",
        effectParams: {},
        targetPlayerId: null,
        parentCastId: heist,
        castInputs: { dc_d20: 15 },
      });
      return { roundId, resolveWith: thief.client };
    },
  },
  {
    name: "6-heist-fizzled-victim-played-first",
    phases: ["4a", "5", "6"],
    note: "The victim cast the pinned card before rolling, so the Heist traces held -> fizzled (victim_played_first).",
    async seed(ctx) {
      const thief = await ctx.signUp("thief");
      const victim = await ctx.signUp("victim");
      const roundId = await ctx.openAndCloseRound(thief, [victim]);
      await ctx.seedRoll(roundId, thief.googleSub, 5);
      await ctx.seedRoll(roundId, victim.googleSub, 12);
      // The victim's own cast spends the card (seedCast returns it to the deck).
      const { cardInstanceId: played } = await ctx.seedCast(roundId, victim.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 2 },
        targetPlayerId: victim.googleSub,
      });
      await ctx.seedCast(roundId, thief.googleSub, "Tea Heist", {
        effectKind: "card_heist",
        effectParams: {},
        targetPlayerId: victim.googleSub,
        castInputs: { stolen_instance_id: played },
      });
      return { roundId, resolveWith: thief.client };
    },
  },

  // =========================================================================
  // WILD — Wild Brew Surge, all six d6 branches. The parent wild_dispatch row
  // carries cast_inputs.branch = N; each branch's post-dispatch child cast is
  // seeded in its simplest deterministic form so resolve_round processes it
  // through the ordinary phases (issue #366 note: WILD dispatch itself runs at
  // cast time, so the corpus seeds its *recorded outcome*, not the d6 roll).
  // =========================================================================
  {
    name: "wild-1-room-reset",
    phases: ["5"],
    wildBranch: 1,
    note: "WILD branch 1 resets every room modifier to 0 at cast time; the resolver then makes a default pick.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 6);
      await ctx.seedRoll(roundId, p2.googleSub, 14);
      await ctx.setRoomModifier(p1.roomId, p1.googleSub, 0);
      await ctx.setRoomModifier(p1.roomId, p2.googleSub, 0);
      await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "wild_dispatch",
        effectParams: { branch: 1 },
        targetPlayerId: null,
        castInputs: { branch: 1 },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "wild-2-persistent-plus-three-caster",
    phases: ["4b", "5"],
    wildBranch: 2,
    note: "WILD branch 2 arms a one-sided persistent_modifier_transfer +3 on the caster; Phase 4b projects it.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 9);
      await ctx.seedRoll(roundId, p2.googleSub, 10);
      const { castId: parent } = await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "wild_dispatch",
        effectParams: { branch: 2 },
        targetPlayerId: null,
        castInputs: { branch: 2 },
      });
      await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "persistent_modifier_transfer",
        effectParams: { delta: 3 },
        targetPlayerId: p1.googleSub,
        parentCastId: parent,
        extra: { source_cast_id: null },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "wild-3-modifier-swap-pair",
    phases: ["4b", "5"],
    wildBranch: 3,
    note: "WILD branch 3 arms a two-sided persistent_modifier_transfer pair (caster <-> other modifier swap); Phase 4b projects both.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 9);
      await ctx.seedRoll(roundId, p2.googleSub, 10);
      await ctx.setRoomModifier(p1.roomId, p1.googleSub, 5);
      await ctx.setRoomModifier(p1.roomId, p2.googleSub, 1);
      const { castId: parent } = await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "wild_dispatch",
        effectParams: { branch: 3 },
        targetPlayerId: null,
        castInputs: { branch: 3 },
      });
      const { castId: first } = await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "persistent_modifier_transfer",
        effectParams: { delta: 1 - 5 },
        targetPlayerId: p1.googleSub,
        parentCastId: parent,
        castInputs: { p1_modifier: 5, p2_modifier: 1 },
        extra: { source_cast_id: null },
      });
      await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "persistent_modifier_transfer",
        effectParams: { delta: 5 - 1 },
        targetPlayerId: p2.googleSub,
        parentCastId: parent,
        extra: { source_cast_id: first },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "wild-4-table-forced-reroll",
    phases: ["3", "5"],
    wildBranch: 4,
    note: "WILD branch 4 arms a forced_reroll the resolver's roll phase adopts from the recorded transform.",
    async seed(ctx) {
      const p1 = await ctx.signUp("rerolled");
      const p2 = await ctx.signUp("caster");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 17);
      await ctx.seedRoll(roundId, p2.googleSub, 8);
      const { castId: parent } = await ctx.seedCast(roundId, p2.googleSub, "Wild Brew Surge", {
        effectKind: "wild_dispatch",
        effectParams: { branch: 4 },
        targetPlayerId: null,
        castInputs: { branch: 4 },
      });
      const win = await ctx.openWindow(roundId);
      await ctx.seedCast(roundId, p2.googleSub, "Wild Brew Surge", {
        effectKind: "forced_reroll",
        effectParams: {},
        targetPlayerId: p1.googleSub,
        reactionWindowId: win,
        parentCastId: parent,
        castInputs: ctx.rollTransform("forced_reroll", 2, [{ player_id: p1.googleSub, before: 17, after: 3 }]),
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "wild-5-high-low-modifier-swap-pair",
    phases: ["4b", "5"],
    wildBranch: 5,
    note: "WILD branch 5 arms a highest<->lowest persistent_modifier_transfer pair; Phase 4b projects both.",
    async seed(ctx) {
      const p1 = await ctx.signUp("highest-mod");
      const p2 = await ctx.signUp("lowest-mod");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 9);
      await ctx.seedRoll(roundId, p2.googleSub, 10);
      await ctx.setRoomModifier(p1.roomId, p1.googleSub, 7);
      await ctx.setRoomModifier(p1.roomId, p2.googleSub, 2);
      const { castId: parent } = await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "wild_dispatch",
        effectParams: { branch: 5 },
        targetPlayerId: null,
        castInputs: { branch: 5 },
      });
      const { castId: first } = await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "persistent_modifier_transfer",
        effectParams: { delta: 2 - 7 },
        targetPlayerId: p1.googleSub,
        parentCastId: parent,
        castInputs: { p1_modifier: 7, p2_modifier: 2 },
        extra: { source_cast_id: null },
      });
      await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "persistent_modifier_transfer",
        effectParams: { delta: 7 - 2 },
        targetPlayerId: p2.googleSub,
        parentCastId: parent,
        extra: { source_cast_id: first },
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "wild-6-tea-maker-override-chosen",
    phases: ["5"],
    wildBranch: 6,
    note: "WILD branch 6 arms a tea_maker_override mode=chosen naming the brewer for the resolver's Phase 5.",
    async seed(ctx) {
      const p1 = await ctx.signUp("caster");
      const p2 = await ctx.signUp("chosen-brewer");
      const roundId = await ctx.openAndCloseRound(p1, [p2]);
      await ctx.seedRoll(roundId, p1.googleSub, 5);
      await ctx.seedRoll(roundId, p2.googleSub, 17);
      const { castId: parent } = await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "wild_dispatch",
        effectParams: { branch: 6 },
        targetPlayerId: null,
        castInputs: { branch: 6 },
      });
      await ctx.seedCast(roundId, p1.googleSub, "Wild Brew Surge", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen", chosen_player_id: p2.googleSub },
        targetPlayerId: p2.googleSub,
        parentCastId: parent,
      });
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    // Issue #440: Brewmageddon's own step names its compelled set; the
    // compelled Lucky Sip resolves as an ordinary cast; the Forfeit is a
    // no-effect step pointing back at Brewmageddon. The Brewmageddon pre-pass
    // is not a numbered resolver phase, so it has no PHASE_TAGS entry; the
    // declared phases are the Lucky Sip's (4a) and the pick (5).
    name: "1-brewmageddon-compelled-cast-and-forfeit",
    phases: ["4a", "5"],
    note: "compel_cast step (compelled set), a compelled flat_modifier cast, and a forfeit step (no legal target).",
    async seed(ctx) {
      const p1 = await ctx.signUp("brewmageddon");
      const p2 = await ctx.signUp("compelled");
      const p3 = await ctx.signUp("forfeiter");
      const roundId = await ctx.openAndCloseRound(p1, [p2, p3]);
      await ctx.seedRoll(roundId, p1.googleSub, 10);
      await ctx.seedRoll(roundId, p2.googleSub, 12);
      await ctx.seedRoll(roundId, p3.googleSub, 15);
      const { castId: bm } = await ctx.seedCast(roundId, p1.googleSub, "Brewmageddon", {
        effectKind: "compel_cast",
        effectParams: {},
        targetPlayerId: null,
      });
      const { cardInstanceId: sip } = await ctx.seedCast(roundId, p2.googleSub, "Lucky Sip", {
        effectKind: "flat_modifier",
        effectParams: { delta: 3 },
        targetPlayerId: p2.googleSub,
        castInputs: { compelled_by: bm },
      });
      const { cardInstanceId: detox } = await ctx.seedCast(roundId, p3.googleSub, "Greater Detox", {
        effectKind: "forfeit",
        effectParams: {},
        targetPlayerId: p3.googleSub,
        castInputs: { compelled_by: bm, casting_time: "A", reason: "no_legal_target" },
      });
      const { error } = await ctx.admin
        .from("spell_casts")
        .update({
          cast_inputs: {
            compelled: [
              { player_id: p2.googleSub, card_instance_id: sip, casting_time: "A" },
              { player_id: p3.googleSub, card_instance_id: detox, casting_time: "A" },
            ],
          },
        })
        .eq("id", bm);
      if (error) throw error;
      return { roundId, resolveWith: p1.client };
    },
  },
  {
    name: "05-loose-leaf-rolloff",
    phases: ["5"],
    note: "Loose Leaf (#431) — the holder rolls lowest and is named Tea Maker: an unfinished roll-off against the second-lowest roller.",
    async seed(ctx) {
      const holder = await ctx.signUp("holder");
      const second = await ctx.signUp("second");
      const high = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(holder, [second, high]);
      await ctx.seedRoll(roundId, holder.googleSub, 3);
      await ctx.seedRoll(roundId, second.googleSub, 9);
      await ctx.seedRoll(roundId, high.googleSub, 18);
      await looseLeaf(ctx, roundId, holder.googleSub);
      return { roundId, resolveWith: holder.client };
    },
  },
  {
    name: "05-loose-leaf-two-player-inert",
    phases: ["5"],
    note: "Loose Leaf (#431) in a two-player round — no distinct second-lowest roller, so a no-op step and the holder brews.",
    async seed(ctx) {
      const holder = await ctx.signUp("holder");
      const other = await ctx.signUp("other");
      const roundId = await ctx.openAndCloseRound(holder, [other]);
      await ctx.seedRoll(roundId, holder.googleSub, 3);
      await ctx.seedRoll(roundId, other.googleSub, 12);
      await looseLeaf(ctx, roundId, holder.googleSub);
      return { roundId, resolveWith: holder.client };
    },
  },
  {
    name: "05-loose-leaf-named-by-override",
    phases: ["5"],
    note: "Loose Leaf (#431) — an override names the top-rolling holder; the roll-off is against the second-lowest roller, not the lowest.",
    async seed(ctx) {
      const chooser = await ctx.signUp("chooser");
      const second = await ctx.signUp("second");
      const holder = await ctx.signUp("holder");
      const roundId = await ctx.openAndCloseRound(chooser, [second, holder]);
      await ctx.seedRoll(roundId, chooser.googleSub, 2);
      await ctx.seedRoll(roundId, second.googleSub, 8);
      await ctx.seedRoll(roundId, holder.googleSub, 19);
      await ctx.seedCast(roundId, chooser.googleSub, "Wild Brew Surge", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen" },
        targetPlayerId: holder.googleSub,
      });
      await looseLeaf(ctx, roundId, holder.googleSub);
      return { roundId, resolveWith: chooser.client };
    },
  },
  {
    name: "05-loose-leaf-tied-second",
    phases: ["5"],
    note: "Loose Leaf (#431) — two rollers tie for second-lowest: both join the roll-off with the holder, no player-id tiebreak.",
    async seed(ctx) {
      const holder = await ctx.signUp("holder");
      const tiedA = await ctx.signUp("tied-a");
      const tiedB = await ctx.signUp("tied-b");
      const high = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(holder, [tiedA, tiedB, high]);
      await ctx.seedRoll(roundId, holder.googleSub, 3);
      await ctx.seedRoll(roundId, tiedA.googleSub, 9);
      await ctx.seedRoll(roundId, tiedB.googleSub, 9);
      await ctx.seedRoll(roundId, high.googleSub, 18);
      await looseLeaf(ctx, roundId, holder.googleSub);
      return { roundId, resolveWith: holder.client };
    },
  },
  {
    name: "05-loose-leaf-holder-alone-second",
    phases: ["5"],
    note: "Loose Leaf (#431) — an override names the holder, who is themselves the second-lowest roller: no distinct opponent, so a no-op step and the holder brews.",
    async seed(ctx) {
      const chooser = await ctx.signUp("chooser");
      const holder = await ctx.signUp("holder");
      const high = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(chooser, [holder, high]);
      await ctx.seedRoll(roundId, chooser.googleSub, 2);
      await ctx.seedRoll(roundId, holder.googleSub, 8);
      await ctx.seedRoll(roundId, high.googleSub, 19);
      await ctx.seedCast(roundId, chooser.googleSub, "Wild Brew Surge", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen" },
        targetPlayerId: holder.googleSub,
      });
      await looseLeaf(ctx, roundId, holder.googleSub);
      return { roundId, resolveWith: chooser.client };
    },
  },
  // Issue #433: Roll Exemption -- Loaf of Lipton's caster has no layer-0
  // roll (a roll_exemption step says so) and brews by its `chosen`
  // self-override with double modifier gain.
  {
    name: "05-loaf-of-lipton-skips-roll",
    phases: ["3", "5"],
    note: "Loaf of Lipton (#433): its caster skips the layer-0 roll (roll_exemption step) and the chosen self-override names them Tea Maker over the lower roller.",
    async seed(ctx) {
      const loaf = await ctx.signUp("loaf");
      const low = await ctx.signUp("low");
      const high = await ctx.signUp("high");
      const roundId = await ctx.openAndCloseRound(loaf, [low, high]);
      await ctx.seedRoll(roundId, low.googleSub, 2);
      await ctx.seedRoll(roundId, high.googleSub, 17);
      await ctx.seedCast(roundId, loaf.googleSub, "Loaf of Lipton", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen", modifier_gain_multiplier: 2, exempt_from_rolling: true },
        targetPlayerId: loaf.googleSub,
      });
      return { roundId, resolveWith: loaf.client };
    },
  },
  // Issue #434: Tea Cosy -- its caster has no layer-0 roll and holds a
  // one-round brewer_immunity, so an override naming them falls through.
  {
    name: "05-tea-cosy-exempt-and-immune",
    phases: ["3", "5"],
    note: "Tea Cosy (#434): its caster is roll-exempt -- no layer-0 roll (roll_exemption step) -- and is immune this round, so a chosen override naming them falls through to the lowest roller (brewer_immunity step).",
    async seed(ctx) {
      const cosy = await ctx.signUp("cosy");
      const chooser = await ctx.signUp("chooser");
      const low = await ctx.signUp("low");
      const roundId = await ctx.openAndCloseRound(cosy, [chooser, low]);
      await ctx.seedRoll(roundId, chooser.googleSub, 14);
      await ctx.seedRoll(roundId, low.googleSub, 3);
      // The cast and the row it promotes (migration 0141's catalog row).
      await ctx.seedActiveEffect({
        roomId: cosy.roomId,
        targetPlayerId: cosy.googleSub,
        casterId: cosy.googleSub,
        cardName: "Tea Cosy",
        effectKind: "brewer_immunity",
        effectParams: { mode: "tea_cosy", exempt_from_rolling: true },
        roundsRemaining: 1,
        roundId,
      });
      await ctx.seedCast(roundId, chooser.googleSub, "Drip Tray", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen" },
        targetPlayerId: cosy.googleSub,
      });
      return { roundId, resolveWith: chooser.client };
    },
  },
  // Issue #432: Brew IOU -- a `chosen` override that, when it names the Tea
  // Maker, leaves its caster owing a Brew Debt; the Debtor's next round pays.
  {
    name: "05-brew-iou-creates-debt",
    phases: ["5"],
    note: "Brew IOU (#432) names the Tea Maker, so a brew_debt step records that its caster now owes a Brew Debt.",
    async seed(ctx) {
      const caster = await ctx.signUp("caster");
      const target = await ctx.signUp("target");
      const roundId = await ctx.openAndCloseRound(caster, [target]);
      await ctx.seedRoll(roundId, caster.googleSub, 2);
      await ctx.seedRoll(roundId, target.googleSub, 19);
      await ctx.seedCast(roundId, caster.googleSub, "Brew IOU", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen", creates_brew_debt: true },
        targetPlayerId: target.googleSub,
      });
      return { roundId, resolveWith: caster.client };
    },
  },
  {
    name: "05-brew-debt-round-paid",
    phases: ["5"],
    note: "A debt round (#432): the Debtor's next round has no rolls; the ladder is skipped and the Debtor brews, paying the Brew Debt.",
    async seed(ctx) {
      const debtor = await ctx.signUp("debtor");
      const target = await ctx.signUp("target");
      // The earlier Brew IOU round, resolved with the debt recorded on it.
      const iouRound = await ctx.seedPastRound(debtor.roomId, [
        { playerId: debtor.googleSub, value: 2 },
        { playerId: target.googleSub, value: 19 },
      ]);
      const { castId } = await ctx.seedCast(iouRound, debtor.googleSub, "Brew IOU", {
        effectKind: "tea_maker_override",
        effectParams: { mode: "chosen", creates_brew_debt: true },
        targetPlayerId: target.googleSub,
      });
      const { error } = await ctx.admin
        .from("rounds")
        .update({ brewer_id: target.googleSub, cups_made: 2, brewer_source: "brew_iou", brewer_source_cast_id: castId })
        .eq("id", iouRound);
      if (error) throw error;
      const roundId = await ctx.openAndCloseRound(target, [debtor]);
      return { roundId, resolveWith: target.client };
    },
  },
];
