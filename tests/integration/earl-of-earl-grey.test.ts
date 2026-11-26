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

// Runs against a real Supabase stack. Issue #429 (spec #401, design #381):
// Earl of Earl Grey -- "Take the title of Earl. While Earl, you cannot be
// tea-maker -- the next-lowest roller makes tea instead. If a card would force
// tea on you, pass the title to its caster: they become Earl, you lose
// immunity."
//
//   * The title is a `brewer_immunity` row, mode `earl`, unbounded (`persist`),
//     dispellable. There is only ever one Earl: the newest live title row in
//     the room is the Earl, and the round that resolves ends the others
//     (spell_active_effects.ended_in_round_id).
//   * Any tea_maker_override naming the Earl first passes the title to the
//     override's caster, then lands on the ex-Earl, who brews. A declared
//     number matching the Earl is a plain immunity skip -- no transfer.
//   * The resolver only decides the transfer; finalize_layer writes it, so a
//     Provisional Recap's dry run never moves the title (ADR 0007).
// Assertions are on observable outcomes: the picked brewer, the Resolution
// Trace and who holds a live title row afterwards.

const EARL = "Earl of Earl Grey";

describe.skipIf(!hasAnonTestEnv)("Earl of Earl Grey (#429)", () => {
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
    const ps = await Promise.all(labels.map((l) => signUpSignInAndEnterRoom(admin, cleanup, `earl-${l}`)));
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

  /** Earl of Earl Grey, cast for real through cast_spell_card while `roundId` is open. */
  async function castEarl(caster: Player, roundId: string) {
    await forceHold(admin, caster.googleSub, EARL);
    const { data, error } = await caster.client.rpc("cast_spell_card", { p_round_id: roundId });
    expect(error).toBeNull();
    return data as string;
  }

  /** Every Earl title row in the room, live or ended. */
  async function titleRows(roomId: string) {
    const { data, error } = await admin
      .from("spell_active_effects")
      .select("id, target_player_id, caster_id, ended_in_round_id, rounds_remaining, is_undispellable, effect_params")
      .eq("room_id", roomId)
      .eq("effect_kind", "brewer_immunity")
      .order("created_at");
    expect(error).toBeNull();
    return data!;
  }

  // -----------------------------------------------------------------------
  // The card.
  // -----------------------------------------------------------------------

  it("is un-benched and casting it promotes an unbounded, dispellable `earl` row", async () => {
    const { data: inst } = await admin
      .from("spell_deck_instances")
      .select("location, spell_cards!inner(name)")
      .eq("spell_cards.name", EARL)
      .single();
    expect(inst!.location).not.toBe("benched");

    const [caster, other] = await players("cast-a", "cast-b");
    const roundId = await openRound(caster, [other]);
    await castEarl(caster, roundId);

    const rows = await titleRows(caster.roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_player_id: caster.googleSub,
      rounds_remaining: null,
      is_undispellable: false,
      ended_in_round_id: null,
      effect_params: { mode: "earl" },
    });
  });
});
