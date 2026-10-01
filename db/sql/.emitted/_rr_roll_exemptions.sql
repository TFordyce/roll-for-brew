-- _rr_roll_exemptions(p_round_id uuid)
--   -> table (player_id text, cast_id uuid, card_name text)
--
-- Issue #433 (spec #401 F5, design #393): Roll Exemption. The Participants
-- who don't roll this round's Layer 0, one row each, with the cast that
-- exempts them. The one read behind "is this player exempt?" --
-- get_expected_layer_roller_ids leaves them out of Layer 0 (so the roll
-- gate, _layer_is_complete, stall enforcement and the room page follow), and
-- the resolver emits one "skipped their roll" Trace step per row.
--
-- A player is exempt when they cast a card whose catalog effect_params carry
-- `exempt_from_rolling: true` this round (Loaf of Lipton; Tea Cosy, #434),
-- UNLESS that cast group is negated in a CLOSED layer-0 Reaction Window. A
-- counter can itself be countered (_rr_cast_log_resolution, any depth), so
-- negation isn't final while the window is open: the caster stays exempt
-- until it closes. From then on a countered caster is an ordinary expected
-- roller who rolls late, and resolution waits for that roll. There's no
-- stored state: the Cast Log is the only input, the flag lasts one round by
-- construction, and _rr_scrap_round's clean slate (it deletes the pass-1
-- casts) wipes it on a replay.
--
-- Not exempt: an Apprentice copy of the card (`cast_inputs.is_copy`) -- it is
-- materialised at resolve time, long after its caster rolled.
--
-- Covers Layer 0 only; a Tie-Break Reroll Layer reads its own participants.
-- Read-only; safe under the Provisional Recap's rolled-back dry run.
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_roll_exemptions(p_round_id uuid)
returns table (player_id text, cast_id uuid, card_name text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (sc.caster_id) sc.caster_id, sc.id, card.name
    from public.spell_casts sc
    join public.round_participants rp
      on rp.round_id = sc.round_id and rp.player_id = sc.caster_id
    join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
    join public.spell_cards card on card.id = sdi.card_id
   where sc.round_id = p_round_id
     and coalesce((sc.effect_params ->> 'exempt_from_rolling')::boolean, false)
     and not coalesce(sc.cast_inputs ? 'is_copy', false)
     and not (
       exists (
         select 1 from public.spell_reaction_windows w
          where w.round_id = p_round_id and w.layer = 0 and w.status = 'closed'
       )
       -- derived from the counters alone, never the `negated` column: the
       -- resolver also sets that for other reasons (ward pre-pass, seize)
       -- mid-run, which must not un-exempt a player after the round resolves
       and exists (
         select 1 from public._rr_cast_log_resolution(p_round_id) r
          where r.victim_group = sc.card_instance_id
            and r.counter_kind = 'contested_negate'
            and r.counter_succeeded
            and not r.counter_negated
            and not r.counter_backfired
       )
     )
   order by sc.caster_id, sc.cast_at, sc.seq;
$$;

revoke execute on function public._rr_roll_exemptions(uuid) from public, anon, authenticated;
-- The integration suites read it directly with the service role.
grant execute on function public._rr_roll_exemptions(uuid) to service_role;

comment on function public._rr_roll_exemptions(uuid) is
  'Issue #433 (spec #401 F5): Roll Exemption -- the Participants who skip this round''s Layer-0 roll, with the exempting cast and card. A cast whose effect_params carry exempt_from_rolling: true exempts its caster unless its group is negated in a closed layer-0 Reaction Window (until it closes, a counter may still be countered). Apprentice copies never exempt. Backs get_expected_layer_roller_ids and the resolver''s roll_exemption Trace step. Internal.';
