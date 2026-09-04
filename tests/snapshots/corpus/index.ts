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

import type { Scenario } from "./framework";

// tier-derived contested_negate DC: common 2 / rare 5 / epic 10 (migration
// 0080 _rr_tier_default_dc). Lucky Sip is common, so dc_d20 >= 2 succeeds.
const GAMBLER_CONDITION = { condition: { advantage_at_or_above: 15, disadvantage_at_or_below: 5 } };

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
];
