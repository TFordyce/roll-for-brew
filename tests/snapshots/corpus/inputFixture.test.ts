import { describe, expect, it } from "vitest";
import { normaliseInput } from "./inputFixture";

// Pure guard (no DB): regeneration must not churn the committed fixtures, so the normaliser has to be
// independent of the random ids and absolute clock a fresh run produces.
function raw(u: { room: string; round: string; cast: string; fx: string; inst: string; card: string }, p: string, t0: number) {
  const ts = (s: number) => new Date(t0 + s * 1000).toISOString().replace("Z", "+00:00");
  return {
    room_id: u.room,
    db_now: ts(9),
    rooms: [{ id: u.room, is_test: false, date: "2026-10-09", created_at: ts(0) }],
    rounds: [{ id: u.round, room_id: u.room, started_by: p, status: "closed", started_at: ts(1), closed_at: ts(2) }],
    round_participants: [{ round_id: u.round, player_id: p, declared_at: ts(1), excluded_at: null }],
    round_layer_participants: [],
    rolls: [],
    spell_casts: [{ id: u.cast, round_id: u.round, caster_id: p, card_instance_id: u.inst, seq: 7771, cast_at: ts(3), negated: false }],
    active_effects: [{ id: u.fx, room_id: u.room, target_player_id: p, source_cast_id: u.cast, card_id: u.card, created_at: ts(3) }],
    deck_instances: [{ id: u.inst, card_id: u.card, location: "held", held_by_player: p }],
    spell_cards: [{ id: u.card, name: "Card" }],
    spell_card_effects: [],
    room_players: [{ room_id: u.room, player_id: p, modifier: 0, created_at: ts(0) }],
    modifier_adjustments: [],
  };
}

describe("normaliseInput", () => {
  it("is byte-identical across runs with different ids, player ids and clocks", () => {
    const a = { room: "11111111-1111-4111-8111-111111111111", round: "22222222-2222-4222-8222-222222222222", cast: "33333333-3333-4333-8333-333333333333", fx: "44444444-4444-4444-8444-444444444444", inst: "55555555-5555-4555-8555-555555555555", card: "66666666-6666-4666-8666-666666666666" };
    const b = { room: "eeeeeeee-1111-4111-8111-111111111111", round: "dddddddd-2222-4222-8222-222222222222", cast: "cccccccc-3333-4333-8333-333333333333", fx: "bbbbbbbb-4444-4444-8444-444444444444", inst: "aaaaaaaa-5555-4555-8555-555555555555", card: "99999999-6666-4666-8666-666666666666" };
    const one = normaliseInput("s", a.round, raw(a, "g-sub-aaa", Date.UTC(2026, 9, 9)), [a.fx], { "g-sub-aaa": "caster" });
    const two = normaliseInput("s", b.round, raw(b, "g-sub-zzz", Date.UTC(2026, 11, 1)), [b.fx], { "g-sub-zzz": "caster" });
    expect(JSON.stringify(two, null, 2)).toBe(JSON.stringify(one, null, 2));
    expect(one.snapshot.spell_casts[0].seq).toBe(1);
    expect(one.snapshot.rooms[0]).not.toHaveProperty("date");
  });
});
