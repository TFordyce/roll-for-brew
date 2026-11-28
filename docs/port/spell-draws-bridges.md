# Spell draws: flags and bridges (slice 4, #553)

Four commands run through the C# API, each behind its own flag. They record a crit's Pending Spell Draw, draw against it (a random card, or the card the player drew in real life), and run the Test Room's puppet draw. Merging changes nothing for players: with no row, or with the row off, every wrapper in `src/lib/supabase/spellCards.ts` keeps its SQL `.rpc`.

| Flag (`port_flags.slice`) | Endpoint | SQL it replaces |
|---|---|---|
| `recordPendingSpellDraw` | `POST /rounds/{id}/pending-draw` | `record_pending_spell_draw(uuid, text)` |
| `drawPendingSpellCard` | `POST /rounds/{id}/draws` | `draw_pending_spell_card(uuid)` |
| `drawPendingSpellCardManual` | `POST /rounds/{id}/draws/manual` | `draw_pending_spell_card_manual(uuid, uuid)` |
| `drawSpellCardAs` | `POST /rounds/{id}/draws/as` | `draw_spell_card_as(text, uuid, text, uuid, uuid)` |

Migration `0170` seeds all four rows off. The three draws return `{ instanceId, needsSwapDecision, version }`. `instanceId` is null when nothing was drawn: the deck is empty, or the puppet crit's redirect hook returned no recipient. The record returns `{ version }`. Every endpoint runs under the round-row lock and bumps `rooms.version`. It sends `room-changed` in the same transaction (ADR 0011, ADR 0012), and if that send is dropped the draw rolls back (`Announce.Required`).

`draw_spell_card(text, uuid)`, the in-app draw with no round, has no TS caller, so it gets no endpoint. `tests/integration/spell-cards.test.ts` and `bench-nonworking-spell-cards.test.ts` still call it. #554 drops it and moves those tests.

## What C# decides, and the bridges

C# owns the entry checks and the deck claim:

* the actor: the JWT's player resolved with the round (Acting As included), or for the puppet draw the admin caller and the named target;
* the trigger (`nat1` / `nat20`), the Test Room and admin rules, and whether the target exists;
* whether the player has a pending row, plus the guard that blocks a second card while a keep-or-swap decision is open;
* the claim. It is one in-deck instance, at random or of the named card, taken `for update skip locked`, so two concurrent draws never claim the same instance and neither waits on the other (ADR 0012; `SpellDrawHttpTests` covers this with a held lock and with concurrent draws);
* removing the pending row: once a card is claimed, or when the deck is empty. A named card that is not in the deck keeps the row, so the player can retry.

The Draw Redirect rules stay in SQL. They are called as bridges inside the API transaction (Tom's call on #553: bridge, don't port):

| Function | Grant | Called from | Goes when |
|---|---|---|---|
| `_apply_crit_redirect(uuid, text)` | `0167` | `RecordCritDraw` (the record endpoint and Proxy Roll), the puppet draw | it is ported to C#, at the latest by the #570 sweep |
| `_land_drawn_instance(text, uuid, text)` | `0170` | the three draws | `admin_allocate_spell_card` (slice 8) is ported, since it shares `_lock_next_draw_mark` |

`_apply_crit_redirect` picks a crit's recipient (Marked for Brew), spends the mark, and takes its advisory locks. `_land_drawn_instance` fires a Stale Biscuit mark, places the card (held, pending swap, or a nat 1's forced swap), and logs the `spell_draws` row. Both run as invoker, so `rfb_api` also has EXECUTE on what they call: `_rr_active_effects_as_of` and `_rr_participated_rounds_elapsed` (granted in `0167`), and `_lock_next_draw_mark` and `_rr_free_hand_slot` (granted in `0170`). Revoke each grant along with its bridge.

## Flip and rollback (human steps, outside play hours)

Preconditions: the API is deployed with this slice, `NEXT_PUBLIC_API_URL` is set, and the API's `CORS_ORIGINS` includes the app origin. Every flag here is round-scoped, so a room row beats the global row and the Test Room goes first.

```sql
-- 1. Test Room first. Play a round there: a normal nat 20 and its draw, an "I drew this IRL" draw
--    (including a card that is not in the deck), and Roll for Others with a nat 1 and a nat 20.
insert into public.port_flags (slice, room_id, enabled)
  select s, r.id, true
    from unnest(array['recordPendingSpellDraw', 'drawPendingSpellCard', 'drawPendingSpellCardManual', 'drawSpellCardAs']) as s
   cross join public.rooms r where r.is_test
on conflict (slice, room_id) do update set enabled = true;

-- 2. Then global.
update public.port_flags set enabled = true
 where room_id is null and slice in (
   'recordPendingSpellDraw', 'drawPendingSpellCard', 'drawPendingSpellCardManual', 'drawSpellCardAs');
```

Rollback (instant, no deploy). It is safe mid-round because both paths write the same rows: a pending row recorded by one path can be drawn by the other.

```sql
update public.port_flags set enabled = false
 where slice in ('recordPendingSpellDraw', 'drawPendingSpellCard', 'drawPendingSpellCardManual', 'drawSpellCardAs');
```

## SQL-deletion list (#554, after the soak)

* The four entry points in the table above, plus `draw_spell_card(text, uuid)` (no caller), and the four flag rows.
* No helper dies with them. `_land_drawn_instance` and `_lock_next_draw_mark` stay as bridges and for `admin_allocate_spell_card`, and `_apply_crit_redirect` and `_rr_free_hand_slot` stay as bridges.
* The `pending_spell_draws` and `spell_draws` reads (`get_my_pending_spell_draw`, `get_pending_spell_draw`, the `spell_draws` read policy) belong to the room view and casting, not this slice. Check the call graph before #554 revokes any grants.

## Known differences from the SQL path

* These SQL failures were plain exceptions and now have API codes (see `error-codes.md`): an invalid trigger is `invalid_draw_trigger` (400); a draw with no pending row is `no_pending_spell_draw` (409); a draw while a keep-or-swap decision is open is `pending_swap_decision_open` (409); a missing round is `round_not_found` (404); and the puppet draw's admin, Test Room and target checks are `admin_required` (403), `round_not_in_test_room` (422) and `target_player_not_found` (404). A card that is not in the deck stays `card_not_in_deck` (RFB06). The manual-draw action accepts both spellings.
* The puppet draw takes no room id. The round decides the room, so SQL's "round is not in this room" check goes.
* On the SQL path a draw sent no `room-changed` of its own. On the API path every draw sends one, versioned.
