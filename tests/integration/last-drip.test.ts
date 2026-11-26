import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  seedDedicatedRoom,
  seedPastRound,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Issue #426 (spec #401, design #380):
// Last Drip -- "Force the winner of the previous round to make tea instead.
// They gain no modifier from this tea-making." A tea_maker_override with mode
// `prev_round_highest` and modifier_gain 0 at tier 2 of the ladder: the
// previous resolved round's highest layer-0 roller in the room brews (ties:
// lowest modifier_snapshot, then lowest player id). Issue #470: a previous
// winner who isn't a Participant this round, or is Roll-Exempt, is passed
// over for the next-highest previous-round roller. Inert, with a no-op Trace
// step and a reason, only when there's no previous resolved round or nobody
// in its roll list qualifies.
describe.skipIf(!hasAnonTestEnv)("Last Drip: previous round's highest roller brews (#426)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  type Player = Awaited<ReturnType<typeof signUpSignInAndEnterRoom>>;

  /** Signs up the players into their own room, so no other test's rounds count as "previous". */
  async function players<const L extends readonly string[]>(...labels: L): Promise<{ [K in keyof L]: Player }> {
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `ld-${l}`)));
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

  it("is un-benched: the card is in the deck and carries a prev_round_highest override with no gain", async () => {
    const { data: card, error } = await admin
      .from("spell_cards")
      .select("id, spell_deck_instances(location), spell_card_effects(target_role, effect_kind, effect_params)")
      .eq("name", "Last Drip")
      .single();
    expect(error).toBeNull();
    const c = card as unknown as {
      spell_deck_instances: { location: string }[];
      spell_card_effects: { target_role: string; effect_kind: string; effect_params: Record<string, unknown> }[];
    };
    expect(c.spell_deck_instances.map((i) => i.location)).not.toContain("benched");
    expect(c.spell_card_effects).toEqual([
      {
        target_role: "TABLE",
        effect_kind: "tea_maker_override",
        effect_params: { mode: "prev_round_highest", modifier_gain: 0 },
      },
    ]);
  });

  // Issue #470: the cast-time notice reads _last_drip_target for the open round.
  describe("get_last_drip_preview", () => {
    async function preview(p: Player, roundId: string) {
      const { data, error } = await p.client.rpc("get_last_drip_preview", { p_round_id: roundId });
      expect(error).toBeNull();
      return data as { target_player_id: string | null; reason: string | null; passed_over: unknown[] } | null;
    }

    it("names the substitute, and who was passed over, while the previous winner is currently exempt", async () => {
      const [caster, exempt, second] = await players("pv-caster", "pv-exempt", "pv-second");
      await seedPastRound(admin, cleanup, caster.roomId, [
        { playerId: exempt.googleSub, value: 19 },
        { playerId: second.googleSub, value: 12 },
        { playerId: caster.googleSub, value: 5 },
      ]);
      const roundId = await openRound(caster, [exempt, second]);
      await forceHold(admin, exempt.googleSub, "Tea Cosy");
      const { error } = await exempt.client.rpc("cast_spell_card", { p_round_id: roundId });
      expect(error).toBeNull();
      await forceHold(admin, caster.googleSub, "Last Drip");

      expect(await preview(caster, roundId)).toEqual({
        target_player_id: second.googleSub,
        reason: null,
        passed_over: [{ player_id: exempt.googleSub, reason: "roll_exempt" }],
      });
    });

    it("names the previous winner plainly when they qualify", async () => {
      const [caster, winner] = await players("pq-caster", "pq-winner");
      await seedPastRound(admin, cleanup, caster.roomId, [
        { playerId: winner.googleSub, value: 19 },
        { playerId: caster.googleSub, value: 5 },
      ]);
      const roundId = await openRound(caster, [winner]);
      await forceHold(admin, caster.googleSub, "Last Drip");

      expect(await preview(caster, roundId)).toEqual({
        target_player_id: winner.googleSub,
        reason: null,
        passed_over: [],
      });
    });

    it("is null for a player not holding Last Drip", async () => {
      const [caster, other] = await players("pn-caster", "pn-other");
      const roundId = await openRound(caster, [other]);
      await forceHold(admin, caster.googleSub, "Last Drip");

      expect(await preview(other, roundId)).toBeNull();
    });
  });
});
