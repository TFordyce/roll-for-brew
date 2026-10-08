// Golden INPUT fixtures (issue #537, spec #533).
//
// For each corpus scenario the runner can emit the state the scenario resolved from, serialised as the
// C# `RoundSnapshot` wire shape (api/src/RollForBrew.Domain/Snapshot) plus the SQL-computed oracle for the
// liveness port. They live in tests/snapshots/inputs/<scenario>.input.json, next to (never inside) the
// goldens, and are consumed by api/tests/RollForBrew.Tests/GoldenLivenessTests.cs.
//
// Capture happens right after `scenario.seed(ctx)` and before the first get_round_recap, i.e. before any
// resolver write cache (Apprentice copies, tick rows, negated/redirected flags) exists.
//
// Determinism: ids are random per run, so `normaliseInput` rewrites the capture into a stable form:
//   * player ids        -> `p-<label>` (roster)
//   * timestamps        -> fixed epoch + one second per distinct instant, ORDER-PRESERVING (ties stay ties)
//   * every uuid        -> `00000000-0000-4000-8000-<n>` numbered in first-seen order over tables sorted by a
//                          uuid-free natural key (so regeneration gives byte-identical files)
//   * rooms.date, rooms/room_players.created_at -> dropped (today / history of a long-lived room); spell_casts.seq -> rank 1..n; the catalog is trimmed to the cards the fixture references.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Roster } from "./framework";

type Row = Record<string, any>;

export type InputFixture = {
  scenario: string;
  roster: Record<string, string>;
  as_of_round_id: string;
  snapshot: Record<string, any>;
  /** Oracle: ids SQL `_rr_active_effects_as_of(room, round)` returned for the seeded round. */
  expected: { live_effect_ids: string[] };
};

async function rows(q: PromiseLike<{ data: any; error: any }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

const hasRoundCount = (e: Row) =>
  e.rounds_remaining != null ||
  e.effect_params?.participated_rounds_after_cast != null ||
  e.effect_params?.participated_rounds_from_cast != null;

/** Reads the bounded snapshot (the same bounds as RoundSnapshotLoader's SQL) with the service-role client. */
export async function captureRawInput(admin: SupabaseClient, roundId: string): Promise<{ roomId: string; snapshot: Row; live: string[] }> {
  const [round] = await rows(admin.from("rounds").select("*").eq("id", roundId));
  if (!round) throw new Error(`round ${roundId} not found`);
  const roomId = round.room_id as string;

  const roomRounds = await rows(admin.from("rounds").select("*").eq("room_id", roomId));
  const roomRoundIds = roomRounds.map((r) => r.id);
  const roomParts = await rows(admin.from("round_participants").select("*").in("round_id", roomRoundIds));
  const players = [...new Set(roomParts.map((p) => p.player_id as string))];

  const eff1 = await rows(admin.from("spell_active_effects").select("*").eq("room_id", roomId));
  const eff2 = players.length
    ? (await rows(admin.from("spell_active_effects").select("*").in("target_player_id", players))).filter(hasRoundCount)
    : [];
  const eff = [...new Map([...eff1, ...eff2].map((e) => [e.id, e])).values()];
  const effIds = new Set(eff.map((e) => e.id));
  const srcCastIds = new Set(eff.map((e) => e.source_cast_id));

  const castsInRounds = await rows(admin.from("spell_casts").select("*").in("round_id", roomRoundIds));
  const srcCasts = srcCastIds.size ? await rows(admin.from("spell_casts").select("*").in("id", [...srcCastIds])) : [];
  const dispels = (await rows(admin.from("spell_casts").select("*").eq("effect_kind", "dispel"))).filter((c) =>
    effIds.has(c.effect_params?.ended_effect_id),
  );
  const spends = (
    await rows(admin.from("spell_casts").select("*").not("cast_inputs->>courage_token_cast_id", "is", null))
  ).filter((c) => srcCastIds.has(c.cast_inputs?.courage_token_cast_id));
  const casts = [...new Map([...castsInRounds, ...srcCasts, ...dispels, ...spends].map((c) => [c.id, c])).values()];

  const playerParts = players.length ? await rows(admin.from("round_participants").select("*").in("player_id", players)) : [];
  const roundIds = new Set<string>([...roomRoundIds, ...playerParts.map((p) => p.round_id), ...casts.map((c) => c.round_id)]);
  const rounds = await rows(admin.from("rounds").select("*").in("id", [...roundIds]));
  const roomIds = new Set<string>([roomId, ...rounds.map((r) => r.room_id), ...eff.map((e) => e.room_id)]);
  const rooms = await rows(admin.from("rooms").select("*").in("id", [...roomIds]));

  const roomIdSet = new Set(roomRoundIds);
  const partKey = (p: Row) => `${p.round_id}/${p.player_id}`;
  const parts = [...new Map(
    [...roomParts, ...playerParts.filter((p) => roundIds.has(p.round_id) && (roomIdSet.has(p.round_id) || players.includes(p.player_id)))]
      .map((p) => [partKey(p), p]),
  ).values()];

  const layerParts = await rows(admin.from("round_layer_participants").select("*").in("round_id", roomRoundIds));
  const rolls = await rows(admin.from("rolls").select("*").in("round_id", roomRoundIds));
  const held = players.length ? await rows(admin.from("spell_deck_instances").select("*").in("held_by_player", players)) : [];
  const castInstanceIds = [...new Set(casts.map((c) => c.card_instance_id))];
  const castInstances = castInstanceIds.length ? await rows(admin.from("spell_deck_instances").select("*").in("id", castInstanceIds)) : [];
  const instances = [...new Map([...held, ...castInstances].map((i) => [i.id, i])).values()];
  const cardIds = [...new Set([...instances.map((i) => i.card_id), ...eff.map((e) => e.card_id)])];
  const cards = cardIds.length ? await rows(admin.from("spell_cards").select("*").in("id", cardIds)) : [];
  const cardEffects = cardIds.length ? await rows(admin.from("spell_card_effects").select("*").in("card_id", cardIds)) : [];
  const roomPlayers = await rows(admin.from("room_players").select("*").eq("room_id", roomId));
  const adjustments = await rows(admin.from("modifier_adjustments").select("*").eq("room_id", roomId));

  const { data: live, error } = await admin.rpc("_rr_active_effects_as_of", { p_room_id: roomId, p_as_of_round_id: roundId });
  if (error) throw error;

  return {
    roomId,
    live: ((live ?? []) as Row[]).map((e) => e.id as string),
    snapshot: {
      room_id: roomId,
      db_now: new Date().toISOString(),
      rooms: rooms.map(({ date: _date, created_at: _c, ...r }) => r),
      rounds,
      round_participants: parts,
      round_layer_participants: layerParts,
      rolls,
      spell_casts: casts,
      active_effects: eff,
      deck_instances: instances,
      spell_cards: cards,
      spell_card_effects: cardEffects,
      room_players: roomPlayers.map(({ created_at: _c, ...r }) => r),
      modifier_adjustments: adjustments,
    },
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)/g;

function instant(ts: string): [number, number] {
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(ts)!;
  const zone = m[4] === "Z" ? "Z" : m[4]!.length === 3 ? `${m[4]}:00` : m[4]!.includes(":") ? m[4]! : `${m[4]!.slice(0, 3)}:${m[4]!.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return [ms / 1000, Number((m[3] ?? "").padEnd(6, "0").slice(0, 6) || 0)];
}

const cmp = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure and deterministic: capture -> stable, byte-reproducible fixture. */
export function normaliseInput(name: string, roundId: string, raw: Row, live: string[], roster: Roster): InputFixture {
  const asOfRoundId = roundId;
  let text = JSON.stringify({ snapshot: raw, live, roundId: asOfRoundId });

  // players
  const ids = Object.keys(roster).sort((a, b) => b.length - a.length);
  for (const id of ids) text = text.split(id).join(`p-${roster[id]}`);

  // timestamps: order-preserving, one second per distinct instant
  const stamps = [...new Set(text.match(TS) ?? [])].map((s) => ({ s, k: instant(s) })).sort((a, b) => cmp(a.k[0], b.k[0]) || cmp(a.k[1], b.k[1]));
  const mapped = new Map<string, string>();
  let n = -1;
  let prev = "";
  for (const { s, k } of stamps) {
    const key = `${k[0]}.${k[1]}`;
    if (key !== prev) n++;
    prev = key;
    mapped.set(s, new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString().replace(".000Z", ".000000+00:00"));
  }
  text = text.replace(TS, (s) => mapped.get(s)!);

  const doc = JSON.parse(text) as { snapshot: Row; live: string[]; roundId: string };
  const s = doc.snapshot;
  for (const r of s.rooms as Row[]) { delete r.date; delete r.created_at; }
  for (const r of s.room_players as Row[]) delete r.created_at;

  // uuid-free natural sort of every table
  const cardName = new Map<string, string>((s.spell_cards as Row[]).map((c) => [c.id, c.name]));
  const blank = (r: Row) => JSON.stringify(r).replace(UUID, "");
  const sorts: Record<string, (a: Row, b: Row) => number> = {
    rounds: (a, b) => cmp(a.started_at, b.started_at) || cmp(blank(a), blank(b)),
    spell_casts: (a, b) => cmp(a.seq, b.seq),
    active_effects: (a, b) => cmp(a.created_at, b.created_at) || cmp(blank(a), blank(b)),
    deck_instances: (a, b) => cmp(a.held_by_player ?? "", b.held_by_player ?? "") || cmp(cardName.get(a.card_id), cardName.get(b.card_id)) || cmp(blank(a), blank(b)),
    spell_cards: (a, b) => cmp(a.name, b.name),
    spell_card_effects: (a, b) => cmp(cardName.get(a.card_id), cardName.get(b.card_id)) || cmp(a.ordinal, b.ordinal),
    modifier_adjustments: (a, b) => cmp(a.created_at, b.created_at) || cmp(blank(a), blank(b)),
    round_participants: (a, b) => cmp(blank(a), blank(b)),
    round_layer_participants: (a, b) => cmp(blank(a), blank(b)),
    rolls: (a, b) => cmp(blank(a), blank(b)),
    room_players: (a, b) => cmp(a.player_id, b.player_id),
    rooms: (a, b) => cmp(a.is_test, b.is_test) || cmp(blank(a), blank(b)),
  };
  // rooms and participants key off rounds: order them by their round's position so the order is uuid-free
  const roundPos = new Map<string, number>();
  (s.rounds as Row[]).sort(sorts.rounds!).forEach((r, i) => roundPos.set(r.id, i));
  const roomPos = new Map<string, number>();
  (s.rounds as Row[]).forEach((r) => { if (!roomPos.has(r.room_id)) roomPos.set(r.room_id, roomPos.size); });
  const posOf = (r: Row) => roundPos.get(r.round_id) ?? -1;
  sorts.round_participants = (a, b) => posOf(a) - posOf(b) || cmp(a.player_id, b.player_id);
  sorts.round_layer_participants = (a, b) => posOf(a) - posOf(b) || cmp(a.layer, b.layer) || cmp(a.player_id, b.player_id);
  sorts.rolls = (a, b) => posOf(a) - posOf(b) || cmp(a.layer, b.layer) || cmp(a.player_id, b.player_id);
  sorts.rooms = (a, b) => (roomPos.get(a.id) ?? 99) - (roomPos.get(b.id) ?? 99);
  for (const [table, fn] of Object.entries(sorts)) if (Array.isArray(s[table])) s[table].sort(fn);
  // seq is a database-global identity: keep the order, rebase to 1..n
  (s.spell_casts as Row[]).forEach((c, i) => { c.seq = i + 1; });

  // uuids: first-seen over tables in a fixed order, then the remaining scalars
  const order = ["rooms", "rounds", "spell_casts", "active_effects", "spell_cards", "spell_card_effects", "deck_instances", "round_participants", "round_layer_participants", "rolls", "room_players", "modifier_adjustments"];
  const map = new Map<string, string>();
  const see = (t: string) => { for (const u of t.match(UUID) ?? []) if (!map.has(u)) map.set(u, `00000000-0000-4000-8000-${String(map.size + 1).padStart(12, "0")}`); };
  see(JSON.stringify({ room_id: s.room_id }));
  for (const t of order) for (const row of s[t] as Row[]) see(JSON.stringify(row));
  see(JSON.stringify(doc.live));
  const swap = (t: string) => t.replace(UUID, (u) => map.get(u) ?? u);

  const fixture: InputFixture = {
    scenario: name,
    roster: Object.fromEntries(Object.entries(roster).map(([id, label]) => [`p-${label}`, label]).sort(([a], [b]) => cmp(a, b))),
    as_of_round_id: swap(doc.roundId),
    snapshot: JSON.parse(swap(JSON.stringify(s))),
    expected: { live_effect_ids: doc.live.map(swap).sort() },
  };
  return fixture;
}

export async function captureInputFixture(admin: SupabaseClient, name: string, roundId: string, roster: Roster): Promise<InputFixture> {
  const { snapshot, live } = await captureRawInput(admin, roundId);
  return normaliseInput(name, roundId, snapshot, live, roster);
}
