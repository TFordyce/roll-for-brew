-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _auto_pass_reaction_window
--   _compelled_card_has_legal_target
--   _compelled_cast_step_open
--   _compelled_outstanding
--   _fan_out_table_placeholder_casts
--   _fix_compelled_set
--   _forfeit_compelled_card
--   _forfeit_untargetable_compelled_reactions
--   _layer_is_complete
--   _owes_compelled_action_cast
--   _rr_brewmageddon_negated
--   _rr_finish_compelled_cast
--   _rr_resolve_eval
--   admin_proxy_roll
--   advance_layer
--   cast_reaction_spell_card
--   cast_spell_card
--   close_round
--   end_active_effect
--   exclude_round_participant
--   forfeit_stalled_compelled_casts
--   get_compelled_cast_step
--   get_my_compelled_cast
--   get_reaction_stack
--   get_round_recap
--   is_expected_layer_roller
--   pass_reaction_window

-- BEGIN db/sql/functions/_auto_pass_reaction_window.sql
-- _auto_pass_reaction_window
--
-- Skipped by the Skip vote or the stall backstop: a compelled Reaction holder
-- Forfeits instead of keeping the card (decided when #440 was ticketed). The
-- auto-pass rows are still written, so the Recap still names who wasn't
-- heard from. Otherwise unchanged (0114).
create or replace function public._auto_pass_reaction_window(
  p_round_id uuid, p_window_id uuid, p_reason text
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_round integer;
  v_players text[];
  v_player_id text;
begin
  select poll_round into v_poll_round
    from public.spell_reaction_windows
   where id = p_window_id;

  select coalesce(array_agg(w order by w), '{}')
    into v_players
    from public._reaction_window_waiting_on(p_round_id, p_window_id, v_poll_round) w;

  foreach v_player_id in array v_players loop
    perform public._forfeit_compelled_card(p_round_id, v_player_id, p_reason);
  end loop;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id, reason)
  select p_window_id, v_poll_round, unnest(v_players), p_reason
  on conflict (window_id, poll_round, player_id) do nothing;

  perform public.close_reaction_window(p_window_id);
  return v_players;
end;
$$;

revoke execute on function public._auto_pass_reaction_window(uuid, uuid, text) from public, anon, authenticated;
-- END db/sql/functions/_auto_pass_reaction_window.sql

-- BEGIN db/sql/functions/_compelled_card_has_legal_target.sql
-- _compelled_card_has_legal_target
--
-- Whether a compelled holder's card has any legal target in this round. The
-- rules mirror what cast_spell_card / cast_reaction_spell_card /
-- end_active_effect would accept; a card with no cast path at all (an Action
-- CARD-target card other than a Detox) has no legal target either.
create or replace function public._compelled_card_has_legal_target(
  p_round_id uuid, p_player_id text, p_card_instance_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_card_id uuid;
  v_name text;
  v_casting_time text;
  v_target text;
  v_others integer;
  v_dispel_params jsonb;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  select sc.id, sc.name, sc.casting_time, sc.target
    into v_card_id, v_name, v_casting_time, v_target
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.id = p_card_instance_id;

  select count(*) into v_others
    from public.round_participants
   where round_id = p_round_id and player_id <> p_player_id and excluded_at is null;

  if v_casting_time = 'R' then
    if v_target = 'CARD' then
      -- Another player's cast to answer. Brewmageddon itself always is one.
      return exists (
        select 1 from public.spell_casts c
         where c.round_id = p_round_id and c.caster_id <> p_player_id
           and c.effect_kind is distinct from 'forfeit'
      );
    elsif v_target = 'OPPONENT' then
      return v_others >= 1;
    end if;
    return v_target in ('SELF', 'PLAYER', 'TABLE');
  end if;

  -- A Detox (dispel) needs an active effect of a tier it can end.
  select e.effect_params into v_dispel_params
    from public.spell_card_effects e
   where e.card_id = v_card_id and e.effect_kind = 'dispel'
   limit 1;
  if v_dispel_params is not null then
    return exists (
      select 1
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards sc2 on sc2.id = sae.card_id
       where sc2.tier in (select jsonb_array_elements_text(v_dispel_params -> 'tiers'))
    );
  end if;

  if v_name = 'Stir the Pot' then
    return v_others >= 2;
  end if;

  if v_name = 'Tea Heist' then
    -- Only a player holding a card can be robbed (get_heist_targets /
    -- cast_spell_card's RFB53 check). Other compelled Action holders still
    -- hold theirs when the set is fixed.
    return exists (
      select 1 from public.round_participants rp
       where rp.round_id = p_round_id and rp.player_id <> p_player_id
         and rp.excluded_at is null
         and exists (
           select 1 from public.spell_deck_instances sdi
            where sdi.held_by_player = rp.player_id and sdi.location = 'held'
         )
    );
  end if;

  if v_name = 'Genie in the Teapot' then
    -- Any card Genie could name: mirrors cast_spell_card's Genie checks
    -- (keep the by-name list in sync with it).
    return exists (
      select 1
        from public.spell_cards sc
        join public.spell_deck_instances sdi on sdi.card_id = sc.id
       where sdi.location = 'in_deck'
         and sc.casting_time = 'A'
         and sc.tier <> 'epic'
         and sc.target <> 'WILD'
         and sc.name not in (
           'Genie in the Teapot', 'Bes-Tea', 'Tea Leaf', 'Spillage', 'Chai-nge of Heart',
           'Bitter Leech', 'Wild Brew Surge', 'Kettle Crash')
         and exists (
           select 1 from public.spell_card_effects e
            where e.card_id = sc.id and e.target_role <> 'WILD')
    );
  end if;

  if v_target = 'OPPONENT' then
    return v_others >= 1;
  end if;
  return v_target in ('SELF', 'PLAYER', 'CHOSEN_PLAYERS', 'TABLE', 'WILD');
end;
$$;

revoke execute on function public._compelled_card_has_legal_target(uuid, text, uuid) from public, anon, authenticated;
-- END db/sql/functions/_compelled_card_has_legal_target.sql

-- BEGIN db/sql/functions/_compelled_cast_step_open.sql
-- _compelled_cast_step_open
--
-- Whether the Compelled Cast step is still holding rolling: some compelled
-- Action cast is still owed.
--
-- plpgsql, not sql: a sql body is checked at create time, and the generated
-- migration emits functions alphabetically, before the helpers this calls.
create or replace function public._compelled_cast_step_open(p_round_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
  );
end;
$$;

revoke execute on function public._compelled_cast_step_open(uuid) from public, anon, authenticated;
grant execute on function public._compelled_cast_step_open(uuid) to service_role;
-- END db/sql/functions/_compelled_cast_step_open.sql

-- BEGIN db/sql/functions/_compelled_outstanding.sql
-- _compelled_outstanding
--
-- The compelled casts still owed in a round: every entry of a live
-- Brewmageddon's fixed set with no row yet made from that card instance by
-- that holder pointing back at it (a compelled cast or a forfeit). Empty
-- once Brewmageddon is negated -- its pending holders are released.
--
-- plpgsql, not sql: a sql body is checked at create time, and the generated
-- migration emits functions alphabetically, before the helpers this calls.
create or replace function public._compelled_outstanding(p_round_id uuid)
returns table (
  player_id text, card_instance_id uuid, casting_time text, brewmageddon_cast_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select h ->> 'player_id', (h ->> 'card_instance_id')::uuid, h ->> 'casting_time', bm.id
    from public.spell_casts bm
    cross join lateral jsonb_array_elements(coalesce(bm.cast_inputs -> 'compelled', '[]'::jsonb)) h
   where bm.round_id = p_round_id
     and bm.effect_kind = 'compel_cast'
     and not exists (
       select 1 from public.spell_casts c
        where c.round_id = p_round_id
          and c.caster_id = h ->> 'player_id'
          and c.card_instance_id = (h ->> 'card_instance_id')::uuid
          and c.cast_inputs ->> 'compelled_by' = bm.id::text
     )
     and not public._rr_brewmageddon_negated(bm.id);
end;
$$;

revoke execute on function public._compelled_outstanding(uuid) from public, anon, authenticated;
grant execute on function public._compelled_outstanding(uuid) to service_role;
-- END db/sql/functions/_compelled_outstanding.sql

-- BEGIN db/sql/functions/_fan_out_table_placeholder_casts.sql
-- _fan_out_table_placeholder_casts
--
-- close_round's TABLE / ALL_OTHER_PLAYERS placeholder fan-out, lifted out of
-- it unchanged (0083) so a compelled cast made after close can fan its own
-- placeholders out against the final roster. p_card_instance_id null fans out
-- every placeholder in the round (close_round); otherwise only that cast's.
create or replace function public._fan_out_table_placeholder_casts(
  p_round_id uuid, p_card_instance_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_placeholder record;
  v_participant record;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_card_id uuid;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  for v_placeholder in
    select id, caster_id, effect_kind, effect_params, card_instance_id, target_role
      from public.spell_casts
     where round_id = p_round_id
       and target_pending = true
       and target_player_id is null
       and target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
       and (p_card_instance_id is null or card_instance_id = p_card_instance_id)
  loop
    select sc.id into v_card_id
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.id = v_placeholder.card_instance_id;

    for v_participant in
      select rp.player_id
        from public.round_participants rp
       where rp.round_id = p_round_id
         and (v_placeholder.target_role <> 'ALL_OTHER_PLAYERS' or rp.player_id <> v_placeholder.caster_id)
    loop
      v_cast_inputs := null;

      if v_placeholder.effect_kind = 'dice_modifier' then
        v_dice_count := (regexp_match(v_placeholder.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
        v_dice_sides := (regexp_match(v_placeholder.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

        v_roll_total := 0;
        for i in 1..v_dice_count loop
          v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
        end loop;

        v_cast_inputs := jsonb_build_object('dice_roll', v_roll_total);
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_placeholder.caster_id, v_placeholder.card_instance_id, v_participant.player_id, false,
        v_placeholder.effect_kind, v_placeholder.effect_params, v_cast_inputs, v_placeholder.target_role
      );

      perform public.record_active_effect_if_persistent(
        v_room_id, v_placeholder.caster_id, v_participant.player_id, v_card_id,
        v_placeholder.effect_kind, v_placeholder.effect_params, v_placeholder.id
      );
    end loop;
  end loop;
end;
$$;

revoke execute on function public._fan_out_table_placeholder_casts(uuid, uuid) from public, anon, authenticated;
-- END db/sql/functions/_fan_out_table_placeholder_casts.sql

-- BEGIN db/sql/functions/_fix_compelled_set.sql
-- _fix_compelled_set
--
-- Fix the compelled set of every Brewmageddon cast in the round (called by
-- close_round once the roster is locked), then forfeit each compelled Action
-- card with no legal target. A Reaction card's target is checked when the
-- Layer-0 window opens instead (_forfeit_untargetable_compelled_reactions).
create or replace function public._fix_compelled_set(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  update public.spell_casts bm
     set cast_inputs = coalesce(bm.cast_inputs, '{}'::jsonb) || jsonb_build_object(
           'compelled', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'player_id', rp.player_id,
                      'card_instance_id', sdi.id,
                      'casting_time', sc.casting_time)
                    order by rp.player_id)
               from public.round_participants rp
               join public.spell_deck_instances sdi
                 on sdi.held_by_player = rp.player_id and sdi.location = 'held'
               join public.spell_cards sc on sc.id = sdi.card_id
              where rp.round_id = p_round_id and rp.excluded_at is null
           ), '[]'::jsonb))
   where bm.round_id = p_round_id
     and bm.effect_kind = 'compel_cast'
     and not bm.negated;

  for v_owed in
    select o.player_id, o.card_instance_id
      from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
  loop
    if not public._compelled_card_has_legal_target(p_round_id, v_owed.player_id, v_owed.card_instance_id) then
      perform public._forfeit_compelled_card(p_round_id, v_owed.player_id, 'no_legal_target');
    end if;
  end loop;
end;
$$;

revoke execute on function public._fix_compelled_set(uuid) from public, anon, authenticated;
-- END db/sql/functions/_fix_compelled_set.sql

-- BEGIN db/sql/functions/_forfeit_compelled_card.sql
-- _forfeit_compelled_card
--
-- Forfeit a player's outstanding compelled cast: the card goes back to the
-- deck as if played, and a no-effect `forfeit` row points at Brewmageddon.
-- Returns false when the player owes nothing (already cast, or released).
create or replace function public._forfeit_compelled_card(
  p_round_id uuid, p_player_id text, p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  select o.card_instance_id, o.casting_time, o.brewmageddon_cast_id
    into v_owed
    from public._compelled_outstanding(p_round_id) o
   where o.player_id = p_player_id
   limit 1;

  if not found then
    return false;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_owed.card_instance_id
     and held_by_player = p_player_id
     and location = 'held';

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id,
    effect_kind, effect_params, cast_inputs
  )
  values (
    p_round_id, p_player_id, v_owed.card_instance_id, p_player_id,
    'forfeit', '{}'::jsonb,
    jsonb_build_object(
      'compelled_by', v_owed.brewmageddon_cast_id,
      'casting_time', v_owed.casting_time,
      'reason', p_reason)
  );

  return true;
end;
$$;

revoke execute on function public._forfeit_compelled_card(uuid, text, text) from public, anon, authenticated;
-- END db/sql/functions/_forfeit_compelled_card.sql

-- BEGIN db/sql/functions/_forfeit_untargetable_compelled_reactions.sql
-- _forfeit_untargetable_compelled_reactions
--
-- Forfeit each compelled Reaction card with no legal target. advance_layer
-- calls this just before it opens the Layer-0 window.
create or replace function public._forfeit_untargetable_compelled_reactions(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owed record;
begin
  for v_owed in
    select o.player_id, o.card_instance_id
      from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'R'
  loop
    if not public._compelled_card_has_legal_target(p_round_id, v_owed.player_id, v_owed.card_instance_id) then
      perform public._forfeit_compelled_card(p_round_id, v_owed.player_id, 'no_legal_target');
    end if;
  end loop;
end;
$$;

revoke execute on function public._forfeit_untargetable_compelled_reactions(uuid) from public, anon, authenticated;
-- END db/sql/functions/_forfeit_untargetable_compelled_reactions.sql

-- BEGIN db/sql/functions/_layer_is_complete.sql
-- _layer_is_complete(p_round_id uuid, p_layer integer) -> boolean
--
-- The Layer-completeness rules (ADR 0008, issue #414) with no caller-identity
-- gate: whether a round can advance does not depend on who asks. A Layer is
-- complete once every expected roller has rolled and, at Layer 0, neither hold
-- is in place:
--   * a Pending Spell Die (a dice_modifier cast with no rolled value yet,
--     issue #252);
--   * a Deferred Forced-Reroll Target (a pre-roll forced_reroll cast still
--     awaiting its target, issue #325);
--   * the Compelled Cast step (issue #440): a compelled Action cast still
--     owed to Brewmageddon. Nobody can roll then anyway (is_expected_layer_
--     roller), so this only makes the rule explicit here too.
-- The single Layer-completeness read: the identity-gated and stall-resolution
-- variants it replaced were dropped in issue #417.
--
-- Internal: called by advance_layer and finalize_layer, which run with
-- definer rights. Players can't call it; the service role can (tests).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._layer_is_complete(p_round_id uuid, p_layer integer)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.rolls where round_id = p_round_id and layer = p_layer)
     < public.count_expected_layer_rollers(p_round_id, p_layer) then
    return false;
  end if;

  if p_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and effect_kind = 'dice_modifier'
       and not coalesce(cast_inputs ? 'dice_roll', false)
  ) then
    return false;
  end if;

  if p_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind = 'forced_reroll'
       and target_pending = true
       and negated = false
       and reaction_window_id is null
  ) then
    return false;
  end if;

  if p_layer = 0 and public._compelled_cast_step_open(p_round_id) then
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function public._layer_is_complete(uuid, integer) from public, anon, authenticated;
-- The integration suites read completeness directly with the service role.
grant execute on function public._layer_is_complete(uuid, integer) to service_role;

comment on function public._layer_is_complete(uuid, integer) is
  'Issue #414 (ADR 0008): Layer completeness with no caller-identity gate -- every expected roller has rolled and, at Layer 0, no Pending Spell Die is outstanding, no Deferred Forced-Reroll Target hold is in place, and no compelled Action cast is still owed (issue #440). Internal to round advancement.';
-- END db/sql/functions/_layer_is_complete.sql

-- BEGIN db/sql/functions/_owes_compelled_action_cast.sql
-- _owes_compelled_action_cast
--
-- Whether the caller has a compelled Action cast to make now (the Compelled
-- Cast step). cast_spell_card and end_active_effect read this to accept a
-- cast while the round is closed.
create or replace function public._owes_compelled_action_cast(p_round_id uuid, p_player_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.player_id = p_player_id and o.casting_time = 'A'
  );
$$;

revoke execute on function public._owes_compelled_action_cast(uuid, text) from public, anon, authenticated;
-- END db/sql/functions/_owes_compelled_action_cast.sql

-- BEGIN db/sql/functions/_rr_brewmageddon_negated.sql
-- _rr_brewmageddon_negated
--
-- Whether a Brewmageddon cast is negated right now: its own flag (a
-- resolved round), or a live, successful, un-countered contested_negate on
-- its cast group in the reaction stack (the same derivation resolve_round
-- Phase 1 applies, read before the round resolves).
create or replace function public._rr_brewmageddon_negated(p_cast_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select negated from public.spell_casts where id = p_cast_id), false)
      or exists (
        select 1
          from public.spell_casts bm
          cross join lateral public._rr_cast_log_resolution(bm.round_id) r
         where bm.id = p_cast_id
           and r.victim_group = bm.card_instance_id
           and r.counter_kind = 'contested_negate'
           and r.counter_succeeded
           and not r.counter_negated
           and not r.counter_backfired
      );
$$;

revoke execute on function public._rr_brewmageddon_negated(uuid) from public, anon, authenticated;
-- END db/sql/functions/_rr_brewmageddon_negated.sql

-- BEGIN db/sql/functions/_rr_finish_compelled_cast.sql
-- _rr_finish_compelled_cast
--
-- The tail every cast path runs before returning: when the cast just made
-- meets a compelled obligation, fan out its TABLE placeholders (a cast made
-- after close_round missed the close-time fan-out) and tag every row of it
-- with cast_inputs.compelled_by, which both meets the obligation and links
-- the cast to Brewmageddon in the Recap. A no-op for any other cast.
create or replace function public._rr_finish_compelled_cast(
  p_round_id uuid, p_player_id text, p_card_instance_id uuid, p_cast_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brewmageddon_cast_id uuid;
begin
  select o.brewmageddon_cast_id into v_brewmageddon_cast_id
    from public._compelled_outstanding(p_round_id) o
   where o.player_id = p_player_id and o.card_instance_id = p_card_instance_id;

  if v_brewmageddon_cast_id is null then
    return p_cast_id;
  end if;

  perform public._fan_out_table_placeholder_casts(p_round_id, p_card_instance_id);

  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                       || jsonb_build_object('compelled_by', v_brewmageddon_cast_id)
   where round_id = p_round_id
     and card_instance_id = p_card_instance_id
     and caster_id = p_player_id;

  return p_cast_id;
end;
$$;

revoke execute on function public._rr_finish_compelled_cast(uuid, text, uuid, uuid) from public, anon, authenticated;
-- END db/sql/functions/_rr_finish_compelled_cast.sql

-- BEGIN db/sql/functions/_rr_resolve_eval.sql
-- _rr_resolve_eval(p_round_id uuid, p_dry_run boolean) -> jsonb
--
-- The Resolver pipeline itself (Phases 0a/0b Effect Invocation, 1 Cast-Log
-- resolution, 2 ward projection, 3 roll-input accounting, 4a/4b/4c modifier
-- composition, 5 brewer selection), returning the outcome object with its
-- Resolution Trace (`trace`) and layer-0 Resolution Summary (`players`).
-- Split out of resolve_round by issue #404 (ADR 0007).
--
-- It does NOT persist the Trace or the Summary -- resolve_round does that --
-- but it is not write-free either: it maintains Cast-Log caches that its own
-- later phases read back (materialised Apprentice copies, Calami-Tea and
-- Bitter Leech tick rows, negated / redirected / seize flags) and the
-- room_players.modifier cache (Phase 4b). Two callers only:
--   * resolve_round(uuid)  -- p_dry_run = false; the cache writes stick.
--   * _rr_resolve(uuid)    -- p_dry_run = true, inside a subtransaction it
--                             always rolls back, so nothing sticks.
-- p_dry_run changes exactly one thing: the Calami-Tea tick die is not rolled
-- (a dry run must not show a die the real resolve will re-roll).
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_resolve_eval(p_round_id uuid, p_dry_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_roll_count integer;
  v_expected_layer_count integer;

  v_trace jsonb := '[]'::jsonb;
  v_step_index integer := 0;
  -- issue #404/#407: the layer-0 Resolution Summary (ADR 0007), one entry per
  -- layer-0 roller, built from the final working arrays just before Phase 5.
  v_summary jsonb := '[]'::jsonb;

  v_brewer_id text := null;
  v_brewer_source text := 'default';
  v_no_modifier_gain boolean := false;
  v_tied text[];

  -- per-player working state, parallel arrays indexed 1..n
  v_players text[] := array[]::text[];
  v_rolls integer[] := array[]::integer[];
  v_base numeric[] := array[]::numeric[];
  v_composed numeric[] := array[]::numeric[];
  v_snapshots numeric[] := array[]::numeric[];
  v_effects_json jsonb := '{}'::jsonb;   -- { player_id: [ normalised effect, ... ] }

  -- Phase 1 (Cast-Log resolution) working state
  v_has_counters boolean := false;
  v_negated_groups uuid[] := array[]::uuid[];
  v_redirect_map jsonb := '{}'::jsonb;   -- { card_instance_id::text: new_target_player_id }
  v_clr record;
  v_victim record;
  v_bf record;
  v_t jsonb;

  -- Phase 2 (ward projection) working state (issue #309)
  v_ward_map jsonb := '{}'::jsonb;   -- { player_id: [ { domain, polarity, block_earned_modifier, ward_seq, ward_cast_id, ward_card_name }, ... ] }
  v_ward_hit jsonb;
  v_ward_pol text;
  v_ward_idx integer;
  v_wb_before numeric;
  v_wb_after numeric;
  v_lghm_seq bigint;

  v_row record;
  v_el jsonb;
  v_pid text;
  v_i integer;
  v_local_idx integer;
  v_before numeric;
  v_after numeric;
  v_running numeric;
  v_eff_target text;
  v_disp_kind text;   -- issue #319: Phase 3 branch-aware display kind

  -- Phase 3-pre (issue #289): Calami-Tea per-round dice tick working state.
  v_dt record;
  v_dt_roll integer;
  v_dt_layer0_roll integer;
  v_dt_ward jsonb;
  -- issue #289: parallel to v_players -- true where a per_round_dice_tick
  -- (Calami-Tea) dragged this roller's value strictly below its running roll
  -- this round, so _rr_pick_lowest can keep them out of the natural-1 pool.
  v_dice_reduced boolean[] := array[]::boolean[];

  v_has_lghm boolean := false;
  v_lghm_cast record;
  v_high_roll_composed numeric;
  v_lowest_roll integer;

  -- issue #321 (Cloud of Cream / Targeting skip): players carrying a live
  -- `targeting_skip` active effect are dropped from highest/lowest-modifier
  -- *target selection* -- Phase 4c (lowest_gains_highest_modifier, both the
  -- highest-modifier source and the lowest beneficiary) and Phase 5
  -- (tea_maker_override mode `highest_modifier`) -- and the next eligible
  -- player is used. The flag never changes a skipped player's own composed
  -- modifier, nor the default lowest-roll brewer pick.
  v_skip_map jsonb := '{}'::jsonb;   -- { player_id: { ae_id, caster_id } }
  v_skip_players text[] := array[]::text[];
  v_lghm_natural text[] := array[]::text[];
  v_lghm_beneficiaries text[] := array[]::text[];
  v_lghm_high_pid text;
  v_lghm_plain_high_pid text;
  v_tmo_plain_high text;

  v_override record;
  v_declared record;

  -- Phase 4b (issue #311) working state
  v_pm_targets text[] := array[]::text[];
  v_pm_running numeric;
  v_pm_row record;

  -- Phase 4b-pre (issue #342) working state
  v_gen integer;
  v_bl record;

  -- issue #351: layer-0 rollers whose roll was frozen (carried over from the
  -- prior generation on scrap because they hold a roll-domain ward). Set by
  -- _rr_scrap_round; empty on generation 0.
  v_frozen_rollers text[] := array[]::text[];
  v_fz_i integer;

  -- Pre-pass (issue #344) working state
  v_wb record;

  -- Pre-pass (issue #440: Brewmageddon) working state
  v_cc record;
  v_cc_source jsonb;

  -- Phase 0 (issue #316: Effect Invocation) working state
  v_has_invocations boolean := false;
  v_inv record;
  v_src_row record;
  v_cp jsonb;
  v_row_cp jsonb;
  v_inv_instance uuid;
  v_copy_target text;
  v_copy_parent uuid;
  v_copy_role text;
  v_copy_ci jsonb;

  -- issue #320: persistent advantage / disadvantage (Prophe-Tea) Phase 3
  v_has_persistent_adv boolean := false;
  v_pa_value integer;
  v_pa_discarded integer;
  v_pa_kept integer;
begin
  select status, room_id, current_layer, replay_generation, replay_frozen_rollers
    into v_status, v_room_id, v_layer, v_gen, v_frozen_rollers
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  select count(*) into v_participant_count
    from public.round_participants
   where round_id = p_round_id;

  v_expected_layer_count := public.count_expected_layer_rollers(p_round_id, v_layer);
  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_layer_count then
    raise exception 'resolve_round: not all participants have rolled yet';
  end if;

  -- ======================================================================
  -- Tie-break reroll layers (layer > 0): no spell logic at all (issue #219).
  -- ======================================================================
  if v_layer > 0 then
    for v_row in
      select r.player_id, r.value, r.modifier_snapshot
        from public.rolls r
       where r.round_id = p_round_id and r.layer = v_layer
       order by r.player_id
    loop
      v_players := v_players || v_row.player_id;
      v_rolls := v_rolls || v_row.value;
      v_snapshots := v_snapshots || v_row.modifier_snapshot::numeric;
    end loop;

    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_snapshots);

    if array_length(v_tied, 1) = 1 then
      return jsonb_build_object(
        'outcome', 'brewer', 'layer', v_layer,
        'brewer_id', v_tied[1], 'brewer_source', 'default',
        'tied_player_ids', null,
        'cups_made', v_participant_count, 'no_modifier_gain', false,
        'trace', '[]'::jsonb, 'players', null
      );
    end if;

    return jsonb_build_object(
      'outcome', 'tie', 'layer', v_layer,
      'brewer_id', null, 'brewer_source', null,
      'tied_player_ids', to_jsonb(v_tied),
      'cups_made', v_participant_count, 'no_modifier_gain', false,
      'trace', '[]'::jsonb, 'players', null
    );
  end if;

  -- ======================================================================
  -- Layer 0.
  -- ======================================================================

  -- Load this layer's rollers into the parallel working arrays.
  for v_row in
    select r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0
     order by r.player_id
  loop
    v_players := v_players || v_row.player_id;
    v_rolls := v_rolls || v_row.value;
    v_base := v_base || v_row.modifier_snapshot::numeric;
    v_composed := v_composed || v_row.modifier_snapshot::numeric;
    v_snapshots := v_snapshots || v_row.modifier_snapshot::numeric;
    v_dice_reduced := v_dice_reduced || false;   -- issue #289: set in Phase 3
    v_effects_json := jsonb_set(v_effects_json, array[v_row.player_id], '[]'::jsonb, true);
  end loop;

  -- ------------------------------------------------------------------
  -- issue #351: roll-domain ward carry-over. On scrap for replay (#315),
  -- _rr_scrap_round kept the generation-0 layer-0 roll of every participant
  -- holding an active negative-polarity roll-domain ward (Cast-Iron Kettle is
  -- the charter case) instead of clearing it, so they do not re-roll in
  -- generation 1. Emit one `roll_frozen` Trace step per such roller on their
  -- own row -- before === after, so it never moves the composed value. Gated
  -- on replay_generation > 0, so generation-0 rounds are byte-identical.
  -- ------------------------------------------------------------------
  if coalesce(v_gen, 0) > 0 and array_length(v_frozen_rollers, 1) is not null then
    for v_fz_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
      if v_players[v_fz_i] = any (v_frozen_rollers) then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'roll_frozen',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', null,
            'card_name', null,
            'caster_player_id', null
          ),
          v_players[v_fz_i],
          jsonb_build_object('type', 'roll', 'value', v_rolls[v_fz_i]),
          jsonb_build_object('type', 'roll', 'value', v_rolls[v_fz_i])
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 0a: Effect Invocation -- materialise Saucerer's Apprentice copies
  -- (issue #316, spec §10). Runs BEFORE Phase 1 so a copied contested_negate
  -- flows through the counter machinery natively. For every live copy (not
  -- itself negated, source not broken, source caster not holding block_copy)
  -- insert one concrete spell_casts row per source effect row -- caster = the
  -- Apprentice, target = the Apprentice caster (a card-targeted counter keeps
  -- the source's parent_cast_id and re-resolves against the same card), all
  -- RNG copied verbatim from cast_inputs.copy_inputs so this stays pure. The
  -- guard on (source_cast_id, is_copy, generation) makes the insert
  -- idempotent, matching the Bitter Leech tick pattern (issue #342).
  -- ------------------------------------------------------------------
  select exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind is null
       and (cast_inputs ? 'copied_cast_id' or cast_inputs ? 'seized_cast_id')
  ) into v_has_invocations;

  if v_has_invocations then
    for v_inv in select * from public._rr_invocation_resolution(p_round_id) loop
      if v_inv.invocation_kind <> 'copy'
         or v_inv.invocation_negated
         or v_inv.source_broken
         or v_inv.ward_cast_id is not null then
        continue;
      end if;

      if exists (
        select 1 from public.spell_casts
         where round_id = p_round_id
           and source_cast_id = v_inv.invocation_cast_id
           and cast_inputs ? 'is_copy'
           and coalesce(generation, 0) = coalesce(v_gen, 0)
      ) then
        continue;
      end if;

      select card_instance_id into v_inv_instance
        from public.spell_casts where id = v_inv.invocation_cast_id;
      select cast_inputs -> 'copy_inputs' -> 'by_cast' into v_cp
        from public.spell_casts where id = v_inv.invocation_cast_id;
      v_cp := coalesce(v_cp, '{}'::jsonb);

      for v_src_row in
        select id, effect_kind, effect_params, parent_cast_id, reaction_window_id
          from public.spell_casts
         where card_instance_id = v_inv.source_group
         order by seq
      loop
        if v_src_row.effect_kind in ('contested_negate', 'redirect') then
          v_copy_target := null;
          v_copy_parent := v_src_row.parent_cast_id;
          v_copy_role   := 'CARD';
        else
          v_copy_target := v_inv.invocation_caster;
          v_copy_parent := null;
          v_copy_role   := 'CASTER';
        end if;

        -- this source row's fresh RNG, drawn at cast time by
        -- _rr_build_copy_inputs and keyed by the row's own id.
        v_row_cp := coalesce(v_cp -> v_src_row.id::text, '{}'::jsonb);
        v_copy_ci := jsonb_build_object('is_copy', true, 'copy_of_cast_id', v_src_row.id);
        if v_src_row.effect_kind = 'contested_negate' and v_row_cp ? 'dc_d20' then
          v_copy_ci := v_copy_ci
            || jsonb_build_object('dc_d20', (v_row_cp->>'dc_d20')::int, 'dc', (v_row_cp->>'dc')::int);
        elsif v_src_row.effect_kind = 'dice_modifier' and v_row_cp ? 'dice_roll' then
          v_copy_ci := v_copy_ci || jsonb_build_object('dice_roll', (v_row_cp->>'dice_roll')::int);
        elsif v_src_row.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'roll_pair_transform')
              and v_row_cp ? 'roll_transform' then
          v_copy_ci := v_copy_ci || jsonb_build_object('roll_transform', v_row_cp -> 'roll_transform');
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id,
          target_role, source_cast_id, generation
        )
        values (
          p_round_id, v_inv.invocation_caster, v_inv_instance, v_copy_target, false,
          v_src_row.effect_kind, v_src_row.effect_params, v_copy_ci, v_copy_parent,
          v_src_row.reaction_window_id, v_copy_role, v_inv.invocation_cast_id,
          coalesce(v_gen, 0)
        );
      end loop;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 1: Cast-Log resolution (issue #307/#308).
  -- ------------------------------------------------------------------
  select exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind in ('contested_negate', 'redirect')
  ) into v_has_counters;

  if v_has_counters then
    v_negated_groups := array[]::uuid[];
    v_redirect_map := '{}'::jsonb;

    drop table if exists _rr_clr_rows;
    create temp table _rr_clr_rows on commit drop as
      select * from public._rr_cast_log_resolution(p_round_id);

    for v_clr in
      select * from _rr_clr_rows
    loop
      if v_clr.counter_kind = 'contested_negate'
         and v_clr.counter_succeeded
         and not v_clr.counter_negated then
        if not (v_clr.victim_group = any (v_negated_groups)) then
          v_negated_groups := v_negated_groups || v_clr.victim_group;
        end if;
      end if;

      if v_clr.redirect_to is not null then
        v_redirect_map := jsonb_set(
          v_redirect_map,
          array[v_clr.victim_cast_id::text],
          to_jsonb(v_clr.redirect_to),
          true
        );
      end if;
    end loop;

    update public.spell_casts
       set negated = (card_instance_id = any (v_negated_groups))
     where round_id = p_round_id;

    update public.spell_casts
       set redirected_to_cast_id = null
     where round_id = p_round_id and redirected_to_cast_id is not null;

    for v_clr in
      select * from _rr_clr_rows
     where redirect_to is not null
    loop
      if not (v_clr.victim_group = any (v_negated_groups)) then
        update public.spell_casts
           set redirected_to_cast_id = v_clr.counter_cast_id
         where id = v_clr.victim_cast_id;
      end if;
    end loop;

    for v_clr in
      select clr.*, sc.name as counter_card_name
        from _rr_clr_rows clr
        join public.spell_casts c on c.id = clr.counter_cast_id
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       order by clr.counter_seq
    loop
      if v_clr.counter_kind = 'contested_negate' then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'contested_negate',
          jsonb_build_object(
            'cast_id', to_jsonb(v_clr.counter_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_clr.counter_card_name),
            'caster_player_id', to_jsonb(v_clr.counter_caster)
          ),
          v_clr.victim_orig_target,
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value',
            case
              when v_clr.counter_negated then 'countered'
              when v_clr.counter_backfired then 'backfired'
              when v_clr.counter_succeeded then 'negated target'
              else 'no effect'
            end),
          jsonb_build_object(
            'dc_d20', v_clr.counter_dc_d20,
            'dc', v_clr.counter_dc,
            'outcome', case
              when v_clr.counter_backfired then 'backfired'
              when not v_clr.counter_negated and v_clr.counter_succeeded then 'applied'
              else 'no-op'
            end)
        ));
        v_step_index := v_step_index + 1;
      else
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'redirect',
          jsonb_build_object(
            'cast_id', to_jsonb(v_clr.counter_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_clr.counter_card_name),
            'caster_player_id', to_jsonb(v_clr.counter_caster)
          ),
          v_clr.redirect_to,
          jsonb_build_object('type', 'target', 'value', v_clr.victim_orig_target),
          jsonb_build_object('type', 'target', 'value',
            case when v_clr.counter_negated then v_clr.victim_orig_target else v_clr.redirect_to end)
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;

    for v_victim in
      select distinct on (c.card_instance_id)
             c.card_instance_id as group_id,
             c.effect_kind,
             c.target_player_id,
             c.caster_id,
             sc.name as card_name
        from public.spell_casts c
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       where c.round_id = p_round_id
         and c.card_instance_id = any (v_negated_groups)
       order by c.card_instance_id, c.seq
    loop
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        coalesce(v_victim.effect_kind, 'unknown'),
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', null,
          'card_name', to_jsonb(v_victim.card_name),
          'caster_player_id', to_jsonb(v_victim.caster_id)
        ),
        v_victim.target_player_id,
        jsonb_build_object('type', 'status', 'value', 'negated'),
        jsonb_build_object('type', 'status', 'value', 'negated'),
        jsonb_build_object('negated', true)
      ));
      v_step_index := v_step_index + 1;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Pre-pass (issue #344): ward-blocked modifier transfers & snapshots.
  --
  -- cast_spell_card stamped a _rr_ward_block_marker on the primary row of a
  -- Chai-nge of Heart / Tea Leaf / Spillage / Bes-Tea cast whose losing (or
  -- copied) side holds a matching ward. Re-assert whole-group negation (Phase
  -- 1 just cleared negated for the round when a counter was present) and emit
  -- one `warded` step per group. The existing negated filters then do the
  -- rest: Phase 4a drops the snapshot rows, Phase 4b's running sum drops the
  -- transfer rows (its target gather keeps them so both sides revert to base),
  -- and _rr_spell_modifier_delta excludes them from every later baseline.
  -- ------------------------------------------------------------------
  update public.spell_casts sc
     set negated = true
    from (
      select distinct card_instance_id
        from public.spell_casts
       where round_id = p_round_id
         and cast_inputs ? 'ward_blocked_by'
    ) g
   where sc.round_id = p_round_id
     and sc.card_instance_id = g.card_instance_id;

  for v_wb in
    select sc.id as cast_id, sc.caster_id,
           sc.cast_inputs ->> 'ward_blocked_by'          as ward_cast_id,
           sc.cast_inputs ->> 'ward_card_name'           as ward_card_name,
           sc.cast_inputs ->> 'ward_target'              as ward_target,
           (sc.cast_inputs ->> 'would_be_before')::numeric as wb_before,
           (sc.cast_inputs ->> 'would_be_after')::numeric  as wb_after,
           scn.name as card_name
      from public.spell_casts sc
      join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
      join public.spell_cards scn on scn.id = sdi.card_id
     where sc.round_id = p_round_id
       and sc.cast_inputs ? 'ward_blocked_by'
       and sc.cast_inputs ? 'ward_target'
     order by sc.seq
  loop
    v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
      v_step_index,
      'warded',
      jsonb_build_object(
        'cast_id', to_jsonb(v_wb.cast_id),
        'active_effect_id', null,
        'card_name', to_jsonb(v_wb.card_name),
        'caster_player_id', to_jsonb(v_wb.caster_id)
      ),
      v_wb.ward_target,
      jsonb_build_object('type', 'modifier', 'value', v_wb.wb_before),
      jsonb_build_object('type', 'modifier', 'value', v_wb.wb_before),
      jsonb_build_object(
        'blocked_cast_id', to_jsonb(v_wb.cast_id),
        'ward_cast_id', to_jsonb(v_wb.ward_cast_id),
        'ward_card_name', to_jsonb(v_wb.ward_card_name),
        'target', to_jsonb(v_wb.ward_target),
        'would_be_before', v_wb.wb_before,
        'would_be_after', v_wb.wb_after,
        'outcome', 'blocked'
      )
    ));
    v_step_index := v_step_index + 1;
  end loop;

  -- ------------------------------------------------------------------
  -- Pre-pass (issue #440): Brewmageddon -- Compelled Cast and Forfeit.
  --
  -- Neither a `compel_cast` row nor a `forfeit` row changes a roll or a
  -- modifier: the compulsion happened at close_round / in the Compelled Cast
  -- step, and the compelled casts themselves are ordinary casts every later
  -- phase resolves as usual. This only explains them. One `compel_cast` step
  -- per live Brewmageddon naming its compelled set (a no-op when nobody held
  -- a card; a countered one already has Phase 1's negated step), then one
  -- `forfeit` step per Forfeit, in cast order, pointing back at it.
  -- ------------------------------------------------------------------
  for v_cc in
    select c.id as cast_id, c.caster_id, c.effect_kind, c.cast_inputs,
           scn.name as card_name
      from public.spell_casts c
      join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
      join public.spell_cards scn on scn.id = sdi.card_id
     where c.round_id = p_round_id
       and ((c.effect_kind = 'compel_cast' and not c.negated) or c.effect_kind = 'forfeit')
     order by c.seq
  loop
    v_cc_source := jsonb_build_object(
      'cast_id', to_jsonb(v_cc.cast_id),
      'active_effect_id', null,
      'card_name', to_jsonb(v_cc.card_name),
      'caster_player_id', to_jsonb(v_cc.caster_id)
    );
    if v_cc.effect_kind = 'compel_cast' then
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'compel_cast',
        v_cc_source,
        null,
        jsonb_build_object('type', 'status', 'value', 'cast'),
        jsonb_build_object('type', 'status', 'value', 'compelled'),
        jsonb_build_object(
          'compelled_player_ids', coalesce((
            select jsonb_agg(h -> 'player_id' order by h ->> 'player_id')
              from jsonb_array_elements(coalesce(v_cc.cast_inputs -> 'compelled', '[]'::jsonb)) h
          ), '[]'::jsonb),
          'outcome', case
            when jsonb_array_length(coalesce(v_cc.cast_inputs -> 'compelled', '[]'::jsonb)) > 0
              then 'applied' else 'no-op' end)
      ));
    else
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'forfeit',
        v_cc_source,
        v_cc.caster_id,
        jsonb_build_object('type', 'status', 'value', 'held'),
        jsonb_build_object('type', 'status', 'value', 'forfeited'),
        jsonb_build_object(
          'compelled_by', v_cc.cast_inputs -> 'compelled_by',
          'reason', v_cc.cast_inputs -> 'reason',
          'outcome', 'no-op')
      ));
    end if;
    v_step_index := v_step_index + 1;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 0b: Effect Invocation -- seize retarget + copy / seize outcome
  -- (issue #316, spec §10). Runs AFTER Phase 1's counter block, which clears
  -- `negated` for the whole round when a counter is present -- so the seize
  -- collapse-negation of non-kept rows is re-asserted every run, the same way
  -- the #344 Pre-pass re-asserts ward-block negation.
  --
  --   * seize: the seized cast group retargets to its own caster. A fan-out
  --     (same effect_kind + params across N players) collapses to one CASTER
  --     row, the rest negated; a compound card keeps every distinct effect,
  --     each on the caster; already-executed eager roll rows are negated
  --     (Phase 3 unwinds them on the original target -- no re-apply).
  --   * a block_copy ward on the source caster, or a negated / broken-chain
  --     source, makes the copy / seize a no-op -- the card is still burned.
  -- ------------------------------------------------------------------
  if v_has_invocations then
    for v_inv in select * from public._rr_invocation_resolution(p_round_id) loop

      -- ---- block_copy ward: card burned, outcome blocked ----
      if v_inv.ward_cast_id is not null then
        -- clear any cache a prior resolve wrote before the ward was in play
        -- (defensive -- inputs are stable for a closed round, but keep the
        -- derivation and the cache in lock-step regardless).
        update public.spell_casts set seized_by_cast_id = null, copied_cast_id = null
         where round_id = p_round_id
           and (seized_by_cast_id = v_inv.invocation_cast_id or id = v_inv.invocation_cast_id);

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index, 'warded',
          jsonb_build_object(
            'cast_id', to_jsonb(v_inv.invocation_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(case when v_inv.invocation_kind = 'seize'
                                       then 'Brew-merang' else 'Saucerer''s Apprentice' end),
            'caster_player_id', to_jsonb(v_inv.invocation_caster)),
          coalesce(v_inv.source_caster, v_inv.invocation_caster),
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value', 'blocked'),
          jsonb_build_object(
            'blocked_cast_id', to_jsonb(v_inv.invocation_cast_id),
            'ward_cast_id', to_jsonb(v_inv.ward_cast_id),
            'ward_card_name', to_jsonb(v_inv.ward_card_name),
            'target', to_jsonb(coalesce(v_inv.source_caster, v_inv.invocation_caster)),
            'invocation_kind', v_inv.invocation_kind,
            'outcome', 'blocked')));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- ---- negated invoker / broken source: no-op, card burned ----
      if v_inv.invocation_negated or v_inv.source_broken then
        update public.spell_casts set seized_by_cast_id = null, copied_cast_id = null
         where round_id = p_round_id
           and (seized_by_cast_id = v_inv.invocation_cast_id or id = v_inv.invocation_cast_id);

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index, v_inv.invocation_kind,
          jsonb_build_object(
            'cast_id', to_jsonb(v_inv.invocation_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(case when v_inv.invocation_kind = 'seize'
                                       then 'Brew-merang' else 'Saucerer''s Apprentice' end),
            'caster_player_id', to_jsonb(v_inv.invocation_caster)),
          coalesce(v_inv.source_caster, v_inv.invocation_caster),
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value', 'no effect'),
          jsonb_build_object(
            'invocation_kind', v_inv.invocation_kind,
            'outcome', 'no-op',
            'reason', case when v_inv.invocation_negated then 'countered' else 'source broken' end)));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- ---- live copy: header step (materialised rows resolved in Phase 0a) ----
      if v_inv.invocation_kind = 'copy' then
        update public.spell_casts
           set copied_cast_id = v_inv.source_parent_cast_id
         where id = v_inv.invocation_cast_id;

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index, 'copy',
          jsonb_build_object(
            'cast_id', to_jsonb(v_inv.invocation_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb('Saucerer''s Apprentice'::text),
            'caster_player_id', to_jsonb(v_inv.invocation_caster)),
          v_inv.invocation_caster,
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value', 'copied'),
          jsonb_build_object(
            'copied_cast_id', to_jsonb(v_inv.source_parent_cast_id),
            'landed_on', to_jsonb(v_inv.invocation_caster),
            'outcome', 'applied')));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- ---- live seize: retarget the seized group to its own caster ----
      if not exists (
        select 1 from public.spell_casts
         where round_id = p_round_id
           and card_instance_id = v_inv.source_group
           and seized_by_cast_id = v_inv.invocation_cast_id
      ) then
        update public.spell_casts sc set
          target_player_id = case when r.rn = 1 and r.keepable
                                  then v_inv.source_caster else sc.target_player_id end,
          target_role      = case when r.rn = 1 and r.keepable
                                  then 'CASTER' else sc.target_role end,
          target_pending   = false,
          negated          = case when r.rn = 1 and r.keepable then sc.negated else true end,
          seized_by_cast_id = v_inv.invocation_cast_id,
          cast_inputs      = case when r.rn = 1 and r.keepable
                                  then coalesce(sc.cast_inputs, '{}'::jsonb)
                                       || jsonb_build_object('seized_kept', true)
                                  else sc.cast_inputs end
        from (
          select id,
                 (effect_kind is not null
                  and effect_kind not in
                    ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'roll_pair_transform')) as keepable,
                 row_number() over (partition by effect_kind, effect_params order by seq) as rn
            from public.spell_casts
           where round_id = p_round_id and card_instance_id = v_inv.source_group
        ) r
        where r.id = sc.id;
      end if;

      -- every run: re-assert negation on the non-kept seized rows.
      update public.spell_casts
         set negated = true
       where round_id = p_round_id
         and seized_by_cast_id = v_inv.invocation_cast_id
         and not coalesce((cast_inputs ->> 'seized_kept')::boolean, false);

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index, 'seize',
        jsonb_build_object(
          'cast_id', to_jsonb(v_inv.invocation_cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb('Brew-merang'::text),
          'caster_player_id', to_jsonb(v_inv.invocation_caster)),
        v_inv.source_caster,
        jsonb_build_object('type', 'status', 'value', 'cast'),
        jsonb_build_object('type', 'status', 'value', 'seized'),
        jsonb_build_object(
          'seized_by_cast_id', to_jsonb(v_inv.invocation_cast_id),
          'source_caster', to_jsonb(v_inv.source_caster),
          'outcome', 'applied')));
      v_step_index := v_step_index + 1;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 2: ward projection (issue #309).
  --
  -- Load every active ward (spell_active_effects.effect_kind = 'ward')
  -- targeting a layer-0 roller into v_ward_map, keyed by target player, each
  -- carrying its source cast seq (ward_seq -- NULL when projected from a
  -- prior round or seeded). Modifier-domain wards filter Phase 4a / 4c below;
  -- block_earned_modifier suppresses the brewer's tea gain in Phase 5.
  -- Roll-domain wards were already applied as a pre-check in the eager shim
  -- and arrive as `warded` markers on cast_inputs.roll_transform that Phase 3
  -- turns into steps.
  -- ------------------------------------------------------------------
  select coalesce(jsonb_object_agg(t.pid, t.wards), '{}'::jsonb)
    into v_ward_map
    from (
      select sae.target_player_id as pid,
             jsonb_agg(jsonb_build_object(
               'domain', sae.effect_params -> 'domain',
               'polarity', sae.effect_params -> 'polarity',
               'block_earned_modifier', coalesce((sae.effect_params ->> 'block_earned_modifier')::boolean, false),
               -- #310: a ward whose source cast is in an EARLIER round always
               -- counts as earlier-seq than any effect cast this round
               -- (_rr_ward_hit treats a NULL ward_seq as "before every
               -- effect"); only a ward cast in THIS round keeps its real seq,
               -- for correct same-round ordering. This is the same rule
               -- _rr_active_ward_gate already applies via its
               -- `wc.round_id <> p_round_id` short-circuit -- Phase 2 just
               -- reads its own map so it has to encode it here. Behaviour is
               -- unchanged for real rounds: a prior-round ward's seq was
               -- already strictly below every current-round effect seq, and a
               -- carried-forward effect passes ord = NULL regardless.
               'ward_seq', case when wc.round_id = p_round_id then wc.seq else null end,
               'ward_cast_id', sae.source_cast_id,
               'ward_card_name', scw.name
             ) order by sae.created_at) as wards
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards scw on scw.id = sae.card_id
        left join public.spell_casts wc on wc.id = sae.source_cast_id
       where sae.room_id = v_room_id
         and sae.effect_kind = 'ward'
         and sae.target_player_id = any (v_players)
       group by sae.target_player_id
    ) t;

  -- issue #320: is any live persistent advantage / disadvantage projection row
  -- in play this round? Gates the per-roller sub-block in Phase 3 so the common
  -- (no Prophe-Tea) path skips N projection lookups -- mirrors v_has_counters /
  -- v_has_invocations.
  select exists (
    select 1 from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
     where sae.room_id = v_room_id
       and sae.effect_kind in ('advantage', 'disadvantage')
       and sae.target_player_id = any (v_players)
  ) into v_has_persistent_adv;

  -- ------------------------------------------------------------------
  -- Phase 3-pre (issue #289): Calami-Tea per-round dice tick synthesis.
  --
  -- Calami-Tea ("Choose up to 3 players. For the next 3 rounds, they each
  -- subtract 1d4 from their rolls.") is a persistent `per_round_dice_tick`
  -- active effect: one CHOSEN_PLAYERS anchor cast + one spell_active_effects
  -- row per target (rounds_remaining => 3 from the card's duration_rounds).
  -- The anchor itself carries no roll_transform, so it is inert past the
  -- projection -- exactly the Bitter Leech anchor pattern (Phase 4b-pre).
  --
  -- Each round the effect is live, this synthesises one child cast per target
  -- carrying a freshly-rolled 1dN in cast_inputs.roll_transform (kind
  -- 'per_round_dice_tick', order 2 -- after fixed_roll / advantage). The main
  -- Phase 3 walk below then subtracts that die from the target's roll and
  -- emits a `dice_tick` Trace step. Written once per (round, source cast,
  -- generation): a re-resolve finds the tick already present, skips the
  -- insert, and re-reads the recorded die, so the resolver stays deterministic
  -- and the per-tick RNG lives in the Cast Log (spec #302 Tier B primitive 6).
  -- Liveness (cast round + next 2, then stop) is _rr_active_effects_as_of's
  -- call, off the card's duration_rounds = 3.
  --
  -- Ward interaction: a negative-polarity roll-domain ward on the target
  -- (Cast-Iron Kettle) blocks the tick that round -- the synth row goes in
  -- negated (the walk's is_negated branch leaves the roll untouched) and a
  -- `warded` step is emitted here, mirroring Phase 4b-pre's Bitter Leech ward
  -- pre-pass. Re-evaluated every round off the live ward map, so a later tick
  -- after the ward expires still applies.
  -- ------------------------------------------------------------------
  for v_dt in
    select sae.source_cast_id,
           sae.target_player_id as victim_id,
           sae.caster_id        as caster_id,
           coalesce((sae.effect_params ->> 'die')::integer, 4)  as die,
           coalesce((sae.effect_params ->> 'sign')::integer, -1) as sign,
           src.card_instance_id
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_casts src on src.id = sae.source_cast_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'per_round_dice_tick'
  loop
    -- Only tick targets who actually rolled this layer-0 round.
    if not (v_dt.victim_id = any (v_players)) then
      continue;
    end if;

    -- generation-scoped idempotency, like Bitter Leech's Phase 4b-pre: a
    -- replay (#315) that bumps replay_generation must re-roll the tick for the
    -- new generation, not skip on the prior one's rows.
    if exists (
      select 1 from public.spell_casts t
       where t.round_id = p_round_id
         and t.source_cast_id = v_dt.source_cast_id
         and coalesce((t.cast_inputs ->> 'dice_tick')::boolean, false) = true
         and coalesce(t.generation, 0) = coalesce(v_gen, 0)
    ) then
      continue;
    end if;

    -- issue #409 (Provisional Recap): a dry run never rolls the die. The
    -- synth row goes in with `rolled` null, so the walk below subtracts 0 and
    -- the `dice_tick` step reads as pending (the Recap renders "subtracts a
    -- die"); the real die is rolled once, by the persisting resolve.
    v_dt_roll := case when p_dry_run then null
                      else floor(random() * v_dt.die + 1)::integer end;
    v_dt_ward := public._rr_ward_hit(v_ward_map, v_dt.victim_id, 'roll', 'negative', null);

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation, negated
    )
    values (
      p_round_id, v_dt.caster_id, v_dt.card_instance_id, v_dt.victim_id,
      'per_round_dice_tick',
      jsonb_build_object('die', v_dt.die, 'sign', v_dt.sign, 'rolled', v_dt_roll),
      jsonb_build_object(
        'dice_tick', true,
        'roll_transform', jsonb_build_object(
          'kind', 'per_round_dice_tick',
          'order', 2,
          'die', v_dt.die,
          'sign', v_dt.sign,
          'rolled', v_dt_roll,
          'players', jsonb_build_array(jsonb_build_object(
            'player_id', v_dt.victim_id,
            'before', null,
            'after', null,
            'warded', v_dt_ward is not null
          ))
        )
      ),
      v_dt.source_cast_id, coalesce(v_gen, 0), v_dt_ward is not null
    );

    if v_dt_ward is not null then
      select r.value into v_dt_layer0_roll
        from public.rolls r
       where r.round_id = p_round_id and r.layer = 0 and r.player_id = v_dt.victim_id;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'warded',
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', null,
          'card_name', to_jsonb('Calami-Tea'::text),
          'caster_player_id', to_jsonb(v_dt.caster_id)
        ),
        v_dt.victim_id,
        jsonb_build_object('type', 'roll', 'value', v_dt_layer0_roll),
        jsonb_build_object('type', 'roll', 'value', v_dt_layer0_roll),
        jsonb_build_object(
          'blocked_cast_id', null,
          'ward_cast_id', v_dt_ward -> 'ward_cast_id',
          'ward_card_name', v_dt_ward -> 'ward_card_name',
          'target', to_jsonb(v_dt.victim_id),
          'would_be_before', v_dt_layer0_roll,
          -- same floor the live application uses (Phase 3 walk: greatest(1, ...))
          'would_be_after', greatest(1, v_dt_layer0_roll + v_dt.sign * v_dt_roll),
          'outcome', 'blocked'
        )
      ));
      v_step_index := v_step_index + 1;
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 3: roll-input accounting (issue #306/#308/#309/#317/#318/#319).
  -- issue #317: `fixed_roll` is a pre-roll kind recorded by submit_roll (via
  -- _rr_apply_fixed_roll) into cast_inputs.roll_transform at order 0; its
  -- recorded entry (normal or `warded`) flows through the generic branches
  -- below exactly like the reaction-window transforms.
  -- issue #289: a synthesised `per_round_dice_tick` child cast (Calami-Tea,
  -- order 2) flows through the same generic branches -- it carries a recorded
  -- `rolled` die the walk subtracts from the roll.
  -- ------------------------------------------------------------------
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_running := null;

    -- issue #320: persistent advantage / disadvantage (Prophe-Tea). A
    -- rest-of-day advantage lives as a spell_active_effects projection row --
    -- no spell_casts row this round, so nothing for the roll_transform walk
    -- below to pick up. Advantage resolves at submit_roll, BEFORE the reaction
    -- window (spec section 2), so emit its clarity step FIRST and seed
    -- v_running with the advantage-kept die: a later reaction-window transform
    -- on the same roller then chains off it instead of collapsing this step to
    -- a zero-impact one. v_rolls is never touched -- the eager shim already
    -- kept the right die. Skipped for a roller who also has an advantage /
    -- disadvantage spell_casts row this round (its cast round): the walk emits
    -- that step itself. AC note (#320): with no cast row on a projection-only
    -- round there is nothing in the Cast Log to record before->after onto, and
    -- spec section 5 forbids mutating the projection row per round -- the kept
    -- die + rolls.discarded_value (persisted by the shim, migration 0049/0051)
    -- are the durable record the resolver adopts here without re-running RNG.
    if v_has_persistent_adv then
      for v_row in
        select sae.id as effect_id, sae.effect_kind as kind,
               sae.caster_id as caster_id, scp.name as card_name
          from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
          join public.spell_cards scp on scp.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in ('advantage', 'disadvantage')
           and sae.target_player_id = v_pid
           and not exists (
             select 1 from public.spell_casts c
              where c.round_id = p_round_id
                and c.target_player_id = v_pid
                and c.target_pending = false
                and c.effect_kind in ('advantage', 'disadvantage')
           )
         order by sae.created_at
      loop
        select r.value, r.discarded_value into v_pa_value, v_pa_discarded
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0 and r.player_id = v_pid;

        -- The advantage-kept die is rolls.value UNLESS a later reaction-window
        -- transform overwrote it -- in which case that transform recorded the
        -- value it read (the kept die) as its own `before`. Take the earliest
        -- recorded `before` if there is one, else rolls.value.
        select (pe.value ->> 'before')::integer
          into v_pa_kept
          from public.spell_casts casts
          cross join lateral jsonb_array_elements(
            casts.cast_inputs -> 'roll_transform' -> 'players') as pe(value)
         where casts.round_id = p_round_id
           and casts.effect_kind in
             ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip',
              'roll_swap', 'fixed_roll', 'roll_pair_transform', 'per_round_dice_tick')
           and casts.cast_inputs ? 'roll_transform'
           and pe.value ->> 'player_id' = v_pid
         order by (casts.cast_inputs -> 'roll_transform' ->> 'order')::integer,
                  casts.seq
         limit 1;
        v_pa_kept := coalesce(v_pa_kept, v_pa_value);

        v_after := v_pa_kept::numeric;
        if v_pa_discarded is null then
          -- advantage and disadvantage cancelled to a single die, or a fixed
          -- roll suppressed the second draw: a zero-impact step.
          v_before := v_after;
        elsif v_row.kind = 'advantage' then
          v_before := least(v_pa_kept, v_pa_discarded)::numeric;
        else
          v_before := greatest(v_pa_kept, v_pa_discarded)::numeric;
        end if;

        v_running := v_after;   -- the roll_transform walk chains from the kept die

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          v_row.kind,
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', to_jsonb(v_row.effect_id),
            'card_name', to_jsonb(v_row.card_name),
            'caster_player_id', to_jsonb(v_row.caster_id)
          ),
          v_pid,
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object('type', 'roll', 'value', v_after)
        ));
        v_step_index := v_step_index + 1;
      end loop;
    end if;

    for v_row in
      select casts.id as cast_id,
             casts.seq as seq,
             casts.caster_id as caster_id,
             casts.effect_kind as kind,
             casts.negated as is_negated,
             sc.name as card_name,
             (rt.rt ->> 'order')::integer as ord,
             (rt.rt ->> 'op') as pair_op,   -- issue #318: chosen-pair op
             (pe.value ->> 'before')::numeric as p_before,
             (pe.value ->> 'after')::numeric as p_after,
             coalesce((pe.value -> 'warded')::text = 'true', false) as is_warded,
             (pe.value ->> 'would_be_after')::numeric as would_be_after,
             pe.value ->> 'ward_cast_id' as ward_cast_id,
             pe.value ->> 'ward_card_name' as ward_card_name,
             rt.rt -> 'condition' as condition,   -- issue #319: conditional advantage
             (rt.rt ->> 'rolled')::numeric as tick_rolled,   -- issue #289: per-round dice tick
             (rt.rt ->> 'sign')::numeric as tick_sign,
             (rt.rt ->> 'die')::integer as tick_die
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'fixed_roll', 'roll_pair_transform', 'per_round_dice_tick')
         and casts.cast_inputs ? 'roll_transform'
         and pe.value ->> 'player_id' = v_pid
       order by (rt.rt ->> 'order')::integer, casts.seq
    loop
      -- issue #309: a roll-domain ward pre-empted this transform in the eager
      -- shim -- the roll was not mutated. Emit a `warded` step and keep the
      -- running value unchanged.
      if v_row.is_warded then
        v_before := coalesce(v_running, v_row.p_before);
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', to_jsonb(v_row.cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_row.card_name),
            'caster_player_id', to_jsonb(v_row.caster_id)
          ),
          v_pid,
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object(
            'blocked_cast_id', to_jsonb(v_row.cast_id),
            'ward_cast_id', to_jsonb(v_row.ward_cast_id),
            'ward_card_name', to_jsonb(v_row.ward_card_name),
            'target', to_jsonb(v_pid),
            'would_be_before', v_before,
            'would_be_after', coalesce(v_row.would_be_after, v_before),
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- issue #308: a NEGATED roll transform is logically unwound. issue #289:
      -- a warded Calami-Tea tick arrives here (synth row negated in Phase
      -- 3-pre, `warded` step already emitted) -- p_before is null, so v_running
      -- stays untouched and the roll is unchanged.
      if v_row.is_negated then
        v_running := coalesce(v_running, v_row.p_before);
        continue;
      end if;

      -- issue #289: Calami-Tea per-round dice tick. The die was rolled and
      -- recorded in Phase 3-pre (cast_inputs.roll_transform.rolled); subtract
      -- it (sign = -1) from the running roll and emit a `dice_tick` step.
      -- p_before / p_after are null on a synth tick row -- the value is derived
      -- from the running roll, not the recorded pair, so a re-resolve over the
      -- same recorded die reproduces the same result.
      if v_row.kind = 'per_round_dice_tick' then
        v_before := coalesce(v_running, v_rolls[v_i])::numeric;
        v_after := greatest(1, v_before + coalesce(v_row.tick_sign, -1) * coalesce(v_row.tick_rolled, 0));
        v_running := v_after;

        -- issue #289 (Tom's call): a roll dragged down here is not a natural 1
        -- -- flag it so _rr_pick_lowest keeps it out of the nat-1 auto-lose
        -- pool. Only when the value actually dropped (a raw 1 hitting the floor
        -- is still a natural 1).
        if v_after < v_before then
          v_dice_reduced[v_i] := true;
        end if;

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'dice_tick',
          jsonb_build_object(
            'cast_id', to_jsonb(v_row.cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_row.card_name),
            'caster_player_id', to_jsonb(v_row.caster_id)
          ),
          v_pid,
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object('type', 'roll', 'value', v_after),
          jsonb_build_object(
            'die', v_row.tick_die,
            'rolled', v_row.tick_rolled,
            'sign', coalesce(v_row.tick_sign, -1)
          )
        ));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      v_before := coalesce(v_running, v_row.p_before);
      v_after := v_row.p_after;
      v_running := v_after;

      -- issue #319: a conditional-advantage cast (Gambler's Infusion) keeps
      -- effect_kind 'advantage', but the branch its first die selected is
      -- recorded in roll_transform.condition. Name that branch on the step:
      -- 'advantage' / 'disadvantage' for a met threshold, else a zero-impact
      -- 'conditional_advantage' step (before === after).
      v_disp_kind := v_row.kind;
      if v_row.condition is not null then
        v_disp_kind := case v_row.condition ->> 'branch'
          when 'advantage' then 'advantage'
          when 'disadvantage' then 'disadvantage'
          else 'conditional_advantage'
        end;
      end if;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_disp_kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_row.card_name),
          'caster_player_id', to_jsonb(v_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'roll', 'value', v_before),
        jsonb_build_object('type', 'roll', 'value', v_after),
        case
          -- issue #318: carry the chosen-pair op so the Recap renderer can
          -- tell swap / set-both-lower / set-both-higher apart.
          when v_row.pair_op is not null
            then jsonb_build_object('op', v_row.pair_op)
          -- issue #319: conditional advantage names which branch fired.
          when v_row.condition is not null
            then jsonb_build_object('condition', v_row.condition)
          else null
        end
      ));
      v_step_index := v_step_index + 1;
    end loop;

    -- issue #308: backfire re-applies the victim group's eager roll
    -- transforms once more onto the reactor (this player), after their own.
    if v_has_counters then
      for v_bf in
        select c.id as counter_cast_id, csc.name as card_name, c.caster_id,
               c.cast_inputs -> 'backfire' -> 'transforms' as transforms
          from _rr_clr_rows clr
          join public.spell_casts c on c.id = clr.counter_cast_id
          join public.spell_deck_instances csdi on csdi.id = c.card_instance_id
          join public.spell_cards csc on csc.id = csdi.card_id
         where clr.counter_backfired
           and clr.counter_caster = v_pid
         order by clr.counter_seq
      loop
        for v_t in
          select value
            from jsonb_array_elements(coalesce(v_bf.transforms, '[]'::jsonb)) t(value)
           order by (value->>'order')::int
        loop
          v_before := coalesce(v_running, v_rolls[v_i])::numeric;
          v_after := case v_t->>'kind'
            when 'disadvantage' then least(v_before,
              (v_t->'extra_dice'->>0)::numeric, (v_t->'extra_dice'->>1)::numeric)
            when 'advantage' then greatest(v_before,
              (v_t->'extra_dice'->>0)::numeric, (v_t->'extra_dice'->>1)::numeric)
            when 'forced_reroll' then (v_t->'extra_dice'->>0)::numeric
            when 'roll_flip' then 21 - v_before
            else v_before
          end;
          v_running := v_after;

          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            v_t->>'kind',
            jsonb_build_object(
              'cast_id', to_jsonb(v_bf.counter_cast_id),
              'active_effect_id', null,
              'card_name', to_jsonb(v_bf.card_name),
              'caster_player_id', to_jsonb(v_bf.caster_id)
            ),
            v_pid,
            jsonb_build_object('type', 'roll', 'value', v_before),
            jsonb_build_object('type', 'roll', 'value', v_after),
            jsonb_build_object('backfire', true)
          ));
          v_step_index := v_step_index + 1;
        end loop;
      end loop;
    end if;

    if v_running is not null then
      v_rolls[v_i] := v_running::integer;
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 4a: gather modifier-bucket effects, normalise, bucket per
  -- target player in application order (spec section 6).
  -- ------------------------------------------------------------------
  for v_row in
    select eff.target_player_id, eff.group_id, eff.effect_kind, eff.effect_params, eff.cast_inputs,
           eff.cast_id, eff.active_effect_id, eff.card_name, eff.caster_player_id, eff.ord
      from (
        select casts.target_player_id,
               casts.card_instance_id as group_id,
               casts.effect_kind,
               casts.effect_params,
               casts.cast_inputs,
               casts.id as cast_id,
               null::uuid as active_effect_id,
               sc.name as card_name,
               casts.caster_id as caster_player_id,
               casts.seq as ord,
               casts.cast_at as ts
          from public.spell_casts casts
          join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
          join public.spell_cards sc on sc.id = sdi.card_id
         where casts.round_id = p_round_id
           and casts.target_pending = false
           and casts.negated = false
           and casts.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
           and sc.duration_rounds is null
        union all
        select sae.target_player_id,
               null::uuid as group_id,
               sae.effect_kind,
               sae.effect_params,
               null::jsonb as cast_inputs,
               null::uuid as cast_id,
               sae.id as active_effect_id,
               sc.name as card_name,
               sae.caster_id as caster_player_id,
               null::bigint as ord,
               sae.created_at as ts
          from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
          join public.spell_cards sc on sc.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
      ) eff
     order by eff.ord asc nulls first, eff.ts asc
  loop
    v_eff_target := coalesce(
      case when v_row.cast_id is not null
        then v_redirect_map ->> v_row.cast_id::text
      end,
      v_row.target_player_id
    );

    if not (v_eff_target = any (v_players)) then
      continue;
    end if;

    v_el := jsonb_build_object(
      'ord', coalesce(v_row.ord, 0),
      'kind', v_row.effect_kind,
      'cast_id', v_row.cast_id,
      'active_effect_id', v_row.active_effect_id,
      'card_name', v_row.card_name,
      'caster_player_id', v_row.caster_player_id,
      'target_player', v_eff_target
    );

    if v_row.effect_kind = 'flat_modifier' then
      v_el := v_el || jsonb_build_object('flat', coalesce((v_row.effect_params->>'delta')::numeric, 0));
    elsif v_row.effect_kind = 'dice_modifier' then
      -- #312: dice_modifier's flat contribution is the recorded dice_roll
      -- (raw, unsigned) * sign. An unrolled Pending Spell Die (no dice_roll
      -- key) contributes 0 -- resolve_round never runs with one outstanding
      -- (the _layer_is_complete hold keeps Layer finalization from running).
      v_el := v_el || jsonb_build_object('flat',
        case
          when v_row.cast_inputs ? 'dice_roll'
            then (v_row.cast_inputs->>'dice_roll')::numeric
                 * coalesce((v_row.effect_params->>'sign')::numeric, 1)
          else 0
        end);
    elsif v_row.effect_kind = 'modifier_multiplier' then
      v_el := v_el || jsonb_build_object('mult', coalesce((v_row.effect_params->>'multiplier')::numeric, 1));
    elsif v_row.effect_kind = 'set_modifier' then
      v_el := v_el || jsonb_build_object('set', coalesce((v_row.effect_params->>'value')::numeric, 0));
    end if;

    -- issue #309: ward filter (Phase 2). Drop a modifier-domain effect whose
    -- computed polarity matches an EARLIER-SEQ ward on its effective target;
    -- emit a `warded` step instead of bucketing it. v_row.ord is the cast
    -- seq (NULL for a carried-forward persistent effect -- _rr_ward_hit then
    -- treats every ward as earlier).
    if v_ward_map ? v_eff_target then
      v_ward_idx := array_position(v_players, v_eff_target);
      v_ward_pol := public._rr_el_polarity(v_el, v_base[v_ward_idx]);
      v_ward_hit := public._rr_ward_hit(v_ward_map, v_eff_target, 'modifier', v_ward_pol, v_row.ord);

      if v_ward_hit is not null then
        v_wb_before := v_base[v_ward_idx];
        v_wb_after := public._rr_compose_modifier(v_base[v_ward_idx], jsonb_build_array(v_el));
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', v_el -> 'cast_id',
            'active_effect_id', v_el -> 'active_effect_id',
            'card_name', v_el -> 'card_name',
            'caster_player_id', v_el -> 'caster_player_id'
          ),
          v_eff_target,
          jsonb_build_object('type', 'modifier', 'value', v_wb_before),
          jsonb_build_object('type', 'modifier', 'value', v_wb_after),
          jsonb_build_object(
            'blocked_cast_id', v_el -> 'cast_id',
            'ward_cast_id', v_ward_hit -> 'ward_cast_id',
            'ward_card_name', v_ward_hit -> 'ward_card_name',
            'target', to_jsonb(v_eff_target),
            'would_be_before', v_wb_before,
            'would_be_after', v_wb_after,
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
        v_ward_hit := null;
        continue;
      end if;
      v_ward_hit := null;
    end if;

    v_effects_json := jsonb_set(
      v_effects_json,
      array[v_eff_target],
      (v_effects_json -> v_eff_target) || jsonb_build_array(v_el),
      true
    );
  end loop;

  -- issue #308: backfire re-buckets every lazy modifier row of a backfired
  -- counter's victim group onto the reactor.
  if v_has_counters then
    for v_bf in
      select clr.counter_cast_id, clr.counter_caster, clr.counter_seq,
             csc.name as counter_card_name, c.caster_id as counter_caster_id,
             pr.id as parent_row_id, pr.effect_kind as pr_kind,
             pr.effect_params as pr_params,
             c.cast_inputs -> 'backfire' -> 'dice_rolls' as dice_rolls
        from _rr_clr_rows clr
        join public.spell_casts c on c.id = clr.counter_cast_id
        join public.spell_deck_instances csdi on csdi.id = c.card_instance_id
        join public.spell_cards csc on csc.id = csdi.card_id
        join public.spell_casts pr on pr.card_instance_id = clr.victim_group
         and pr.effect_kind in
           ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
       where clr.counter_backfired
       order by clr.counter_seq, pr.seq
    loop
      if not (v_bf.counter_caster = any (v_players)) then
        continue;
      end if;

      v_el := jsonb_build_object(
        'ord', v_bf.counter_seq,
        'kind', v_bf.pr_kind,
        'cast_id', v_bf.counter_cast_id,
        'active_effect_id', null,
        'card_name', v_bf.counter_card_name,
        'caster_player_id', v_bf.counter_caster_id,
        'target_player', v_bf.counter_caster,
        'backfire', true
      );

      if v_bf.pr_kind = 'flat_modifier' then
        v_el := v_el || jsonb_build_object('flat', coalesce((v_bf.pr_params->>'delta')::numeric, 0));
      elsif v_bf.pr_kind = 'dice_modifier' then
        v_el := v_el || jsonb_build_object('flat',
          coalesce((v_bf.dice_rolls ->> v_bf.parent_row_id::text)::numeric, 0)
          * coalesce((v_bf.pr_params->>'sign')::numeric, 1));
      elsif v_bf.pr_kind = 'modifier_multiplier' then
        v_el := v_el || jsonb_build_object('mult', coalesce((v_bf.pr_params->>'multiplier')::numeric, 1));
      elsif v_bf.pr_kind = 'set_modifier' then
        v_el := v_el || jsonb_build_object('set', coalesce((v_bf.pr_params->>'value')::numeric, 0));
      end if;

      -- issue #309: ward filter also applies to a backfired counter's
      -- re-bucketed rows landing on the reactor (spec §8).
      if v_ward_map ? v_bf.counter_caster then
        v_ward_idx := array_position(v_players, v_bf.counter_caster);
        v_ward_pol := public._rr_el_polarity(v_el, v_base[v_ward_idx]);
        v_ward_hit := public._rr_ward_hit(v_ward_map, v_bf.counter_caster, 'modifier', v_ward_pol, v_bf.counter_seq);

        if v_ward_hit is not null then
          v_wb_before := v_base[v_ward_idx];
          v_wb_after := public._rr_compose_modifier(v_base[v_ward_idx], jsonb_build_array(v_el));
          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            'warded',
            jsonb_build_object(
              'cast_id', v_el -> 'cast_id',
              'active_effect_id', null,
              'card_name', v_el -> 'card_name',
              'caster_player_id', v_el -> 'caster_player_id'
            ),
            v_bf.counter_caster,
            jsonb_build_object('type', 'modifier', 'value', v_wb_before),
            jsonb_build_object('type', 'modifier', 'value', v_wb_after),
            jsonb_build_object(
              'blocked_cast_id', v_el -> 'cast_id',
              'ward_cast_id', v_ward_hit -> 'ward_cast_id',
              'ward_card_name', v_ward_hit -> 'ward_card_name',
              'target', to_jsonb(v_bf.counter_caster),
              'would_be_before', v_wb_before,
              'would_be_after', v_wb_after,
              'backfire', true,
              'outcome', 'blocked'
            )
          ));
          v_step_index := v_step_index + 1;
          v_ward_hit := null;
          continue;
        end if;
        v_ward_hit := null;
      end if;

      v_effects_json := jsonb_set(
        v_effects_json,
        array[v_bf.counter_caster],
        (v_effects_json -> v_bf.counter_caster) || jsonb_build_array(v_el),
        true
      );
    end loop;
  end if;

  -- Compose each player's final modifier, and emit one Trace step per
  -- effect with a running before/after over the prefix up to it.
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_after := v_base[v_i];

    for v_local_idx, v_el in
      select o, value
        from jsonb_array_elements(v_effects_json -> v_pid) with ordinality as e(value, o)
       order by o
    loop
      v_before := v_after;
      v_after := public._rr_compose_modifier(
        v_base[v_i],
        (select coalesce(jsonb_agg(value order by o), '[]'::jsonb)
           from jsonb_array_elements(v_effects_json -> v_pid) with ordinality as e(value, o)
          where o <= v_local_idx)
      );

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_el ->> 'kind',
        jsonb_build_object(
          'cast_id', v_el -> 'cast_id',
          'active_effect_id', v_el -> 'active_effect_id',
          'card_name', v_el -> 'card_name',
          'caster_player_id', v_el -> 'caster_player_id'
        ),
        v_pid,
        jsonb_build_object('type', 'modifier', 'value', v_before),
        jsonb_build_object('type', 'modifier', 'value', v_after),
        case when v_el ? 'backfire'
          then jsonb_build_object('backfire', true)
          else '{}'::jsonb
        end
      ));
      v_step_index := v_step_index + 1;
    end loop;

    v_composed[v_i] := v_after;
  end loop;

  -- ------------------------------------------------------------------
  -- issue #321 (Cloud of Cream): collect the players carrying a live
  -- `targeting_skip` active effect, keyed for Trace attribution. Read once
  -- here; consumed by Phase 4c and Phase 5 below. DISTINCT ON so two Cloud of
  -- Cream instances on one player collapse to their earliest.
  -- ------------------------------------------------------------------
  select coalesce(
           jsonb_object_agg(pid, jsonb_build_object('ae_id', ae_id, 'caster_id', caster_id)),
           '{}'::jsonb)
    into v_skip_map
    from (
      select distinct on (sae.target_player_id)
             sae.target_player_id as pid, sae.id as ae_id, sae.caster_id as caster_id
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
       where sae.room_id = v_room_id
         and sae.effect_kind = 'targeting_skip'
         and sae.target_player_id is not null
       order by sae.target_player_id, sae.created_at
    ) s;
  v_skip_players := array(select jsonb_object_keys(v_skip_map));

  -- ------------------------------------------------------------------
  -- Phase 4c: lowest_gains_highest_modifier (Broken Biscuit).
  -- ------------------------------------------------------------------
  select true into v_has_lghm
    from public.spell_casts casts
    join public.spell_reaction_windows w on w.id = casts.reaction_window_id
   where w.round_id = p_round_id and w.layer = 0
     and casts.effect_kind = 'lowest_gains_highest_modifier'
     and casts.negated = false
   limit 1;

  if coalesce(v_has_lghm, false) and coalesce(array_length(v_players, 1), 0) > 0 then
    select casts.id as id, casts.seq as seq, casts.caster_id as caster_id, sc.name as name
      into v_lghm_cast
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where w.round_id = p_round_id and w.layer = 0
       and casts.effect_kind = 'lowest_gains_highest_modifier'
       and casts.negated = false
     order by casts.seq
     limit 1;
    v_lghm_seq := v_lghm_cast.seq;

    v_lowest_roll := (select min(x) from unnest(v_rolls) x);

    -- The plain highest roller (roll desc, then player id asc) -- kept for
    -- issue #321 Trace attribution below.
    select v_players[i] into v_lghm_plain_high_pid
      from generate_subscripts(v_players, 1) i
     order by v_rolls[i] desc, v_players[i]
     limit 1;

    -- issue #321: the "highest modifier" source. Normally the plain highest
    -- roller's composed modifier; a Cloud of Cream holder is skipped and the
    -- next-highest non-skipped roller is used. If every roller is skipped,
    -- fall back to the plain highest so the lift still resolves.
    select v_players[i] into v_lghm_high_pid
      from generate_subscripts(v_players, 1) i
     where not (v_players[i] = any (v_skip_players))
     order by v_rolls[i] desc, v_players[i]
     limit 1;
    if v_lghm_high_pid is null then
      v_lghm_high_pid := v_lghm_plain_high_pid;
    end if;
    v_high_roll_composed := v_composed[array_position(v_players, v_lghm_high_pid)];

    -- issue #321 Trace: the plain highest roller was skipped off the source.
    if v_lghm_plain_high_pid is not null
       and v_lghm_plain_high_pid <> v_lghm_high_pid
       and (v_skip_map ? v_lghm_plain_high_pid) then
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'targeting_skip',
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', v_skip_map -> v_lghm_plain_high_pid -> 'ae_id',
          'card_name', to_jsonb('Cloud of Cream'::text),
          'caster_player_id', v_skip_map -> v_lghm_plain_high_pid -> 'caster_id'
        ),
        v_lghm_plain_high_pid,
        jsonb_build_object('type', 'status', 'value', 'targetable'),
        jsonb_build_object('type', 'status', 'value', 'skipped')
      ));
      v_step_index := v_step_index + 1;
    end if;

    -- issue #321: beneficiaries. Normally every tied-lowest roller; a Cloud
    -- of Cream holder among them is skipped and the lift moves to the next
    -- eligible (non-skipped) roller in roll-ascending order, keeping the
    -- beneficiary count the same ("apply to the next player instead").
    select coalesce(array_agg(v_players[i] order by v_rolls[i], v_players[i]), array[]::text[])
      into v_lghm_natural
      from generate_subscripts(v_players, 1) i
     where v_rolls[i] = v_lowest_roll;

    if coalesce(array_length(v_skip_players, 1), 0) = 0
       or not (v_lghm_natural && v_skip_players) then
      v_lghm_beneficiaries := v_lghm_natural;
    else
      select coalesce(array_agg(pid order by rk), array[]::text[])
        into v_lghm_beneficiaries
        from (
          select v_players[i] as pid,
                 row_number() over (order by v_rolls[i], v_players[i]) as rk
            from generate_subscripts(v_players, 1) i
           where not (v_players[i] = any (v_skip_players))
        ) s
       where rk <= coalesce(array_length(v_lghm_natural, 1), 0);
      -- every roller skipped -> nobody eligible; keep the natural set.
      if coalesce(array_length(v_lghm_beneficiaries, 1), 0) = 0 then
        v_lghm_beneficiaries := v_lghm_natural;
      end if;
    end if;

    -- issue #321 Trace: one step per natural beneficiary the skip removed.
    foreach v_pid in array v_lghm_natural loop
      if (v_skip_map ? v_pid) and not (v_pid = any (v_lghm_beneficiaries)) then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'targeting_skip',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', v_skip_map -> v_pid -> 'ae_id',
            'card_name', to_jsonb('Cloud of Cream'::text),
            'caster_player_id', v_skip_map -> v_pid -> 'caster_id'
          ),
          v_pid,
          jsonb_build_object('type', 'status', 'value', 'targetable'),
          jsonb_build_object('type', 'status', 'value', 'skipped')
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;

    foreach v_pid in array v_lghm_beneficiaries loop
      v_i := array_position(v_players, v_pid);
      -- issue #309: a warded beneficiary is excluded from the lift
      -- (lowest_gains_highest_modifier is statically positive). Others are
      -- still lifted. The lghm cast is a reaction, so its seq is after any
      -- pre-roll ward.
      v_ward_hit := public._rr_ward_hit(v_ward_map, v_players[v_i], 'modifier', 'positive', v_lghm_seq);
      if v_ward_hit is not null then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', to_jsonb(v_lghm_cast.id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_lghm_cast.name),
            'caster_player_id', to_jsonb(v_lghm_cast.caster_id)
          ),
          v_players[v_i],
          jsonb_build_object('type', 'modifier', 'value', v_composed[v_i]),
          jsonb_build_object('type', 'modifier', 'value', v_composed[v_i]),
          jsonb_build_object(
            'blocked_cast_id', to_jsonb(v_lghm_cast.id),
            'ward_cast_id', v_ward_hit -> 'ward_cast_id',
            'ward_card_name', v_ward_hit -> 'ward_card_name',
            'target', to_jsonb(v_players[v_i]),
            'would_be_before', v_composed[v_i],
            'would_be_after', v_high_roll_composed,
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
        v_ward_hit := null;
        continue;
      end if;

      v_before := v_composed[v_i];
      v_after := v_high_roll_composed;
      v_composed[v_i] := v_after;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'lowest_gains_highest_modifier',
        jsonb_build_object(
          'cast_id', to_jsonb(v_lghm_cast.id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_lghm_cast.name),
          'caster_player_id', to_jsonb(v_lghm_cast.caster_id)
        ),
        v_players[v_i],
        jsonb_build_object('type', 'modifier', 'value', v_before),
        jsonb_build_object('type', 'modifier', 'value', v_after)
      ));
      v_step_index := v_step_index + 1;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 4b: persistent modifier delta projection (issue #311, spec §9).
  --
  -- Spec §6 numbers this "4b" (adjacent to modifier composition), but it is
  -- coded here, after Phase 4c: the persistent rest-of-day delta is
  -- independent of the round-composed modifier and of 4c's in-place lift of
  -- v_composed, so ordering relative to 4a/4c is immaterial and running last
  -- avoids interleaving with the composed-array walk.
  --
  -- For every player targeted by a non-negated persistent_modifier_transfer
  -- or persistent_modifier_spend cast in THIS round, set the materialized
  -- room_players.modifier cache to base + rest-of-day spell delta and emit one
  -- Trace step per cast with a deterministic running before -> after. Players
  -- not touched by a transfer this round keep their existing modifier -- every
  -- non-spell writer (brewer gain, adjustments, admin tools) and Kettle
  -- Crash's imperative reset stay authoritative for them.
  --
  -- The recompute is absolute (base + full delta), so re-running resolve_round
  -- over the same inputs reproduces the same room_players.modifier and the
  -- same steps. The per-step `before` is derived from base + the delta of
  -- earlier-seq matching casts, never from the live room_players.modifier, so
  -- it does not drift on a second run.
  --
  -- ADR 0005 note: a transfer's `delta` is a cast-time snapshot of a mutable
  -- room_players.modifier (WILD branch 3/5 -- see cast_spell_card). The value
  -- is recorded in the Cast Log, so a replay reproduces it; the swap outcome
  -- is path-dependent on cast timing, the same grudging exception the ADR
  -- grants the eager shim. Within this slice only one snapshot-taking cast per
  -- round is reachable (a single Wild Brew Surge instance in the deck), so no
  -- same-round transfer reads another's not-yet-projected delta.
  -- ------------------------------------------------------------------
  -- Phase 4b-pre (issue #342): Bitter Leech per-round tick synthesis.
  --
  -- Each still-live Bitter Leech active effect (a persistent_modifier_transfer
  -- row carrying a 'per_round_delta') projects one -per_round_delta /
  -- +per_round_delta persistent_modifier_transfer pair into THIS round's Cast
  -- Log -- the target loses, the caster gains. The pair then flows through the
  -- ordinary Phase 4b projection and _rr_spell_modifier_delta /
  -- get_modifier_breakdown exactly like a Chai-nge / WILD transfer, so the
  -- breakdown reconciles for free. Written once per (round, source cast): a
  -- re-resolve finds the tick already present and skips the insert, and the
  -- absolute recompute below reproduces the same room_players.modifier.
  -- Liveness (cast round + next 2 rounds, then stop) is
  -- _rr_active_effects_as_of's call, off the card's duration_rounds = 3.
  for v_bl in
    select sae.source_cast_id,
           sae.target_player_id as victim_id,
           sae.caster_id        as beneficiary_id,
           coalesce((sae.effect_params ->> 'per_round_delta')::numeric, 1) as per_round_delta,
           src.card_instance_id
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_casts src on src.id = sae.source_cast_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'persistent_modifier_transfer'
       and sae.effect_params ? 'per_round_delta'
  loop
    if exists (
      select 1 from public.spell_casts t
       where t.round_id = p_round_id
         and t.source_cast_id = v_bl.source_cast_id
         and coalesce((t.cast_inputs ->> 'bitter_leech_tick')::boolean, false) = true
         -- generation-scoped like _rr_spell_modifier_delta (0085): a replay
         -- (#315) that bumps the round's replay_generation must re-emit the
         -- tick for the new generation, not skip on the prior one's rows.
         and coalesce(t.generation, 0) = coalesce(v_gen, 0)
    ) then
      continue;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation
    )
    values (
      p_round_id, v_bl.beneficiary_id, v_bl.card_instance_id, v_bl.victim_id,
      'persistent_modifier_transfer', jsonb_build_object('delta', -v_bl.per_round_delta),
      jsonb_build_object('bitter_leech_tick', true), v_bl.source_cast_id, coalesce(v_gen, 0)
    );

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation
    )
    values (
      p_round_id, v_bl.beneficiary_id, v_bl.card_instance_id, v_bl.beneficiary_id,
      'persistent_modifier_transfer', jsonb_build_object('delta', v_bl.per_round_delta),
      jsonb_build_object('bitter_leech_tick', true), v_bl.source_cast_id, coalesce(v_gen, 0)
    );
  end loop;

  -- Pre-pass (issue #344): a Bitter Leech tick landing on a warded victim is
  -- skipped -- both synthesised rows are negated, so the pair no-ops this
  -- round while the target gather below still reverts the victim's cache.
  -- Re-evaluated every round off the live ward map (Phase 2), so a later tick
  -- after the ward expires still applies. Runs over freshly synthesised AND
  -- pre-existing tick rows so a re-resolve re-asserts the same negation.
  for v_bl in
    select t.source_cast_id, t.target_player_id as victim_id
      from public.spell_casts t
     where t.round_id = p_round_id
       and coalesce((t.cast_inputs ->> 'bitter_leech_tick')::boolean, false) = true
       and coalesce((t.effect_params ->> 'delta')::numeric, 0) < 0
       and coalesce(t.generation, 0) = coalesce(v_gen, 0)
     group by t.source_cast_id, t.target_player_id
  loop
    if not (v_bl.victim_id = any (v_players)) then
      continue;
    end if;

    v_ward_hit := public._rr_ward_hit(v_ward_map, v_bl.victim_id, 'modifier', 'negative', null);
    if v_ward_hit is null then
      continue;
    end if;

    update public.spell_casts
       set negated = true
     where round_id = p_round_id
       and source_cast_id = v_bl.source_cast_id
       and coalesce((cast_inputs ->> 'bitter_leech_tick')::boolean, false) = true
       and coalesce(generation, 0) = coalesce(v_gen, 0);

    -- Bitter Leech's per_round_delta is always 1 (cast_spell_card, issue #342).
    v_wb_before := public._rr_base_modifier(v_room_id, v_bl.victim_id)
                 + public._rr_spell_modifier_delta(v_room_id, v_bl.victim_id, p_round_id);

    v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
      v_step_index,
      'warded',
      jsonb_build_object(
        'cast_id', null,
        'active_effect_id', null,
        'card_name', to_jsonb('Bitter Leech'::text),
        'caster_player_id', null
      ),
      v_bl.victim_id,
      jsonb_build_object('type', 'modifier', 'value', v_wb_before),
      jsonb_build_object('type', 'modifier', 'value', v_wb_before),
      jsonb_build_object(
        'blocked_cast_id', null,
        'ward_cast_id', v_ward_hit -> 'ward_cast_id',
        'ward_card_name', v_ward_hit -> 'ward_card_name',
        'target', to_jsonb(v_bl.victim_id),
        'would_be_before', v_wb_before,
        'would_be_after', v_wb_before - 1,
        'outcome', 'blocked'
      )
    ));
    v_step_index := v_step_index + 1;
    v_ward_hit := null;
  end loop;

  -- issue #342: NO negated filter here -- a fully-negated Chai-nge (both
  -- sibling rows flipped by Phase 1) must still bring both players into the
  -- recompute so their caches revert to base + other-round deltas. The inner
  -- loop below still filters negated rows out of the running sum.
  select coalesce(array_agg(distinct sc.target_player_id), array[]::text[])
    into v_pm_targets
    from public.spell_casts sc
   where sc.round_id = p_round_id
     and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
     and sc.target_player_id is not null;

  foreach v_pid in array v_pm_targets loop
    -- deterministic starting point: base + this player's transfer/spend delta
    -- from every OTHER round of the current generation.
    v_pm_running := public._rr_base_modifier(v_room_id, v_pid)
                  + public._rr_spell_modifier_delta(v_room_id, v_pid, p_round_id);

    for v_pm_row in
      select sc.id as cast_id, sc.seq, sc.caster_id, sc.effect_kind,
             coalesce((sc.effect_params ->> 'delta')::numeric, 0) as delta,
             scn.name as card_name
        from public.spell_casts sc
        join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
        join public.spell_cards scn on scn.id = sdi.card_id
       where sc.round_id = p_round_id
         and sc.target_player_id = v_pid
         and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
         and coalesce(sc.negated, false) = false
         -- issue #342: skip the Bitter Leech anchor (no 'delta') and match
         -- _rr_spell_modifier_delta's generation filter so the running sum and
         -- the baseline it starts from never disagree after a replay (#315).
         and sc.effect_params ? 'delta'
         and coalesce(sc.generation, 0) = coalesce(v_gen, 0)
       order by sc.seq
    loop
      v_before := v_pm_running;
      v_pm_running := v_pm_running + v_pm_row.delta;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_pm_row.effect_kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_pm_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_pm_row.card_name),
          'caster_player_id', to_jsonb(v_pm_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'modifier', 'value', v_before),
        jsonb_build_object('type', 'modifier', 'value', v_pm_running),
        jsonb_build_object('delta', v_pm_row.delta, 'rest_of_day', true)
      ));
      v_step_index := v_step_index + 1;
    end loop;

    update public.room_players
       set modifier = v_pm_running::integer
     where room_id = v_room_id and player_id = v_pid;
  end loop;

  -- ------------------------------------------------------------------
  -- Resolution Summary (issue #407, ADR 0007): each layer-0 roller's final
  -- values as Phase 5 compares them -- roll after every roll-input transform,
  -- roll-time modifier, composed modifier, total, and nat standing by
  -- _rr_pick_lowest's own rule (a Calami-Tea-floored 1 is not a natural 1).
  -- Phase 5 moves none of these, so the summary is final here.
  -- ------------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', v_players[i],
           'roll', v_rolls[i],
           'snapshot', v_snapshots[i],
           'composed', v_composed[i],
           'total', v_rolls[i] + v_composed[i],
           'nat', case
             when v_rolls[i] = 1 and not coalesce(v_dice_reduced[i], false) then 'nat1'
             when v_rolls[i] = 20 then 'nat20'
           end,
           'dice_reduced', coalesce(v_dice_reduced[i], false)
         ) order by i), '[]'::jsonb)
    into v_summary
    from generate_subscripts(v_players, 1) i;

  -- ------------------------------------------------------------------
  -- Phase 5: brewer selection. Precedence declared > override > default.
  -- ------------------------------------------------------------------
  for v_declared in
    select sae.id, (sae.effect_params->>'number')::integer as number,
           sae.caster_id, sc.name as card_name
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_cards sc on sc.id = sae.card_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'declared_number_tea_maker'
     order by sae.created_at
  loop
    select r.player_id into v_pid
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0 and r.value = v_declared.number
     limit 1;

    if v_pid is not null then
      v_brewer_id := v_pid;
      v_brewer_source := 'declared_number';
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'declared_number_tea_maker',
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', to_jsonb(v_declared.id),
          'card_name', to_jsonb(v_declared.card_name),
          'caster_player_id', to_jsonb(v_declared.caster_id)
        ),
        v_brewer_id,
        jsonb_build_object('type', 'status', 'value', 'pending'),
        jsonb_build_object('type', 'status', 'value', 'brewer')
      ));
      v_step_index := v_step_index + 1;
      exit;
    end if;
  end loop;

  if v_brewer_id is null then
    select casts.effect_params->>'mode' as mode,
           coalesce((casts.effect_params->>'no_modifier_gain')::boolean, false) as no_modifier_gain,
           casts.target_player_id as chosen_player_id,
           casts.target_pending as target_pending,
           casts.id as cast_id,
           casts.caster_id as caster_id,
           sc.name as card_name
      into v_override
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.effect_kind = 'tea_maker_override'
       and casts.negated = false
     order by casts.cast_at desc, casts.seq desc
     limit 1;

    if v_override.mode is not null and not coalesce(v_override.target_pending, false) then
      if v_override.mode = 'chosen' then
        v_brewer_id := v_override.chosen_player_id;
      elsif v_override.mode = 'highest_roll' then
        select v_players[i] into v_brewer_id
          from generate_subscripts(v_players, 1) i
         order by v_rolls[i] desc, v_players[i]
         limit 1;
      else
        -- 'highest_modifier'. issue #321: a Cloud of Cream holder is skipped
        -- and the next-highest `modifier_snapshot` roller is picked; if every
        -- roller is skipped, fall back to the plain highest.
        select r.player_id into v_tmo_plain_high
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0
         order by r.modifier_snapshot desc, r.player_id
         limit 1;

        select r.player_id into v_brewer_id
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0
           and not (r.player_id = any (v_skip_players))
         order by r.modifier_snapshot desc, r.player_id
         limit 1;

        if v_brewer_id is null then
          v_brewer_id := v_tmo_plain_high;
        elsif v_tmo_plain_high is not null
              and v_tmo_plain_high <> v_brewer_id
              and (v_skip_map ? v_tmo_plain_high) then
          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            'targeting_skip',
            jsonb_build_object(
              'cast_id', null,
              'active_effect_id', v_skip_map -> v_tmo_plain_high -> 'ae_id',
              'card_name', to_jsonb('Cloud of Cream'::text),
              'caster_player_id', v_skip_map -> v_tmo_plain_high -> 'caster_id'
            ),
            v_tmo_plain_high,
            jsonb_build_object('type', 'status', 'value', 'targetable'),
            jsonb_build_object('type', 'status', 'value', 'skipped')
          ));
          v_step_index := v_step_index + 1;
        end if;
      end if;

      v_no_modifier_gain := v_override.no_modifier_gain;
      v_brewer_source := 'tea_maker_override:' || v_override.mode;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'tea_maker_override',
        jsonb_build_object(
          'cast_id', to_jsonb(v_override.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_override.card_name),
          'caster_player_id', to_jsonb(v_override.caster_id)
        ),
        v_brewer_id,
        jsonb_build_object('type', 'status', 'value', 'pending'),
        jsonb_build_object('type', 'status', 'value',
          case when v_no_modifier_gain then 'brewer (no modifier gain)' else 'brewer' end)
      ));
      v_step_index := v_step_index + 1;
    end if;
  end if;

  if v_brewer_id is null then
    -- issue #289: v_dice_reduced excludes a Calami-Tea-floored roll from the
    -- natural-1 auto-lose pool (a real natural 1 still brews).
    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_composed, v_dice_reduced);

    if array_length(v_tied, 1) > 1 then
      -- Phase 6 (issue #438): Tea Heist outcomes -- see the brewer exit below.
      v_trace := v_trace || public._rr_heist_trace(p_round_id, v_step_index);

      return jsonb_build_object(
        'outcome', 'tie', 'layer', 0,
        'brewer_id', null, 'brewer_source', null,
        'tied_player_ids', to_jsonb(v_tied),
        'cups_made', v_participant_count, 'no_modifier_gain', false,
        'trace', v_trace, 'players', v_summary
      );
    end if;

    v_brewer_id := v_tied[1];
    v_brewer_source := 'default';
  end if;

  -- issue #309: a block_earned_modifier ward on the selected brewer (Eternal
  -- Steep) zeroes their tea-making modifier gain. resolve_round(uuid, text,
  -- integer, boolean) turns no_modifier_gain into a zero brewer gain. This is
  -- a property of the ward, not a competing cast, so it applies regardless of
  -- seq.
  if v_brewer_id is not null then
    select w.value into v_ward_hit
      from jsonb_array_elements(coalesce(v_ward_map -> v_brewer_id, '[]'::jsonb)) w
     where coalesce((w.value ->> 'block_earned_modifier')::boolean, false)
     limit 1;

    if v_ward_hit is not null then
      if not v_no_modifier_gain then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', null,
            'card_name', v_ward_hit -> 'ward_card_name',
            'caster_player_id', null
          ),
          v_brewer_id,
          jsonb_build_object('type', 'status', 'value', 'brewer'),
          jsonb_build_object('type', 'status', 'value', 'brewer (no modifier gain)'),
          jsonb_build_object(
            'blocked_cast_id', null,
            'ward_cast_id', v_ward_hit -> 'ward_cast_id',
            'ward_card_name', v_ward_hit -> 'ward_card_name',
            'target', to_jsonb(v_brewer_id),
            'would_be_before', to_jsonb('brewer'::text),
            'would_be_after', to_jsonb('brewer (no modifier gain)'::text),
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
      end if;
      v_no_modifier_gain := true;
      v_ward_hit := null;
    end if;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 6 (issue #438): Tea Heist outcomes. The resolver only DECIDES and
  -- traces here (moved / fizzled / countered) -- this body also runs as the
  -- Provisional Recap's rolled-back dry run, so the card itself is moved by
  -- finalize_layer's commit step (_rr_apply_heists), per the ADR 0005 #383
  -- amendment. Emitted at the tie exit above too, since a tie's layer-0 Trace
  -- is the one the round keeps.
  -- ------------------------------------------------------------------
  v_trace := v_trace || public._rr_heist_trace(p_round_id, v_step_index);

  return jsonb_build_object(
    'outcome', 'brewer', 'layer', 0,
    'brewer_id', v_brewer_id, 'brewer_source', v_brewer_source,
    'tied_player_ids', null,
    'cups_made', v_participant_count, 'no_modifier_gain', v_no_modifier_gain,
    'trace', v_trace, 'players', v_summary
  );
end;
$$;

revoke execute on function public._rr_resolve_eval(uuid, boolean) from public, anon, authenticated;

comment on function public._rr_resolve_eval(uuid, boolean) is
  'Issue #404 (ADR 0007): the body of the authoritative layer-0 resolver, split out of resolve_round. Returns { outcome, layer, brewer_id, brewer_source, tied_player_ids, cups_made, no_modifier_gain, trace, players } without persisting the Trace or the Resolution Summary. Maintains its own Cast-Log / modifier caches, so callers either keep them (resolve_round) or roll them back (_rr_resolve). p_dry_run skips the Calami-Tea tick RNG. Internal.';
-- END db/sql/functions/_rr_resolve_eval.sql

-- BEGIN db/sql/functions/admin_proxy_roll.sql
-- admin_proxy_roll
--
-- Nobody rolls during the Compelled Cast step, a Proxy Roll included.
-- Otherwise unchanged (0071).
create or replace function public.admin_proxy_roll(p_round_id uuid, p_player_id text, p_value integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_modifier integer;
begin
  if p_value is null or p_value < 1 or p_value > 20 then
    raise exception 'admin_proxy_roll: value must be between 1 and 20';
  end if;

  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_proxy_roll: caller is not an admin';
  end if;

  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'admin_proxy_roll: target player not found';
  end if;

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'admin_proxy_roll: round not found';
  end if;

  if v_status not in ('open', 'closed') or exists (
    select 1 from public.rolls where round_id = p_round_id
  ) then
    raise exception 'admin_proxy_roll: round is no longer open for a proxy roll'
      using errcode = 'RFB32';
  end if;

  if v_status = 'closed' and public._compelled_cast_step_open(p_round_id) then
    raise exception 'admin_proxy_roll: rolling is held until every compelled cast is in'
      using errcode = 'RFB54';
  end if;

  -- Implicitly creates the target's today's-room membership — no prior
  -- login required, unlike every other room_players writer
  -- (enter_todays_room, 0003) which always derives the player from the
  -- authenticated caller.
  insert into public.room_players (room_id, player_id)
  values (v_room_id, p_player_id)
  on conflict (room_id, player_id) do nothing;

  insert into public.round_participants (round_id, player_id)
  values (p_round_id, p_player_id)
  on conflict (round_id, player_id) do nothing;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = p_player_id;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, entered_by_admin)
  values (p_round_id, p_player_id, v_layer, p_value, 'manual', v_modifier, true);

  -- Same nat-1/nat-20 pending-draw trigger submit_roll/submit_manual_roll
  -- get via maybeRecordPendingSpellDraw (roundActionHelpers.ts), but
  -- inserted directly for the target player rather than reused via
  -- record_pending_spell_draw (0036) — that RPC resolves its player from
  -- current_player_id(p_round_id), which would credit the admin's own
  -- identity, not the proxied player's.
  if p_value in (1, 20) then
    insert into public.pending_spell_draws (round_id, player_id, trigger)
    values (p_round_id, p_player_id, case when p_value = 1 then 'nat1' else 'nat20' end)
    on conflict (round_id, player_id) do nothing;
  end if;
end;
$$;
-- END db/sql/functions/admin_proxy_roll.sql

-- BEGIN db/sql/functions/advance_layer.sql
-- advance_layer(p_round_id uuid) -> jsonb
--
-- Layer completion (ADR 0008, issue #415): what happens once the current
-- Layer's rolls are all in. Takes the round row lock first -- the same lock
-- finalize_layer and resolve_round take, so the nested calls below reuse it --
-- then does nothing unless the round is `closed` and its current Layer is
-- complete (_layer_is_complete: every expected roller has rolled, and at
-- Layer 0 no Pending Spell Die or Deferred Forced-Reroll Target hold). Then:
--   * Layer 0 with no reaction window yet: opens it (open_reaction_window,
--     which attaches the pre-roll forced_reroll and chosen-pair casts),
--     first forfeiting any compelled Reaction card with no legal target
--     (issue #440: a Reaction card's target is checked when the window
--     opens). If
--     nobody is eligible to react the window closes on the spot and Layer
--     finalization (finalize_layer) runs in this same call.
--   * Layer 0 with a window: an open window is a noop -- the window finishes
--     normally, so a Pending Spell Die resolved mid-window only unblocks
--     finalization -- and a closed one performs Layer finalization.
--   * A Tie-Break Reroll Layer (> 0): performs Layer finalization. No window
--     is ever opened above Layer 0.
--
-- Never opens a second window, and never raises for who the caller is or for
-- losing a race: a second caller blocks on the lock, then finds the window
-- already there (or the round moved on) and returns noop.
--
-- The call that first finds the Layer complete -- the one that opens Layer
-- 0's window, or that finalizes a Tie-Break Reroll Layer -- also returns the
-- Layer's raw (pre-transform) rolls as `layer_rolls`, for the "layer rolls
-- revealed" broadcast. Called by the round-advancement module
-- (src/app/rounds/advanceRound.ts).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.advance_layer(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_layer integer;
  v_window_closed boolean;
  v_layer_rolls jsonb;
  v_finalization jsonb;
begin
  select status, current_layer into v_status, v_layer
    from public.rounds
   where id = p_round_id
     for update;

  if v_status is null then
    return jsonb_build_object('outcome', 'noop', 'reason', 'round_not_found');
  end if;

  if v_status <> 'closed' then
    return jsonb_build_object('outcome', 'noop', 'reason', 'round_not_closed');
  end if;

  if not public._layer_is_complete(p_round_id, v_layer) then
    return jsonb_build_object('outcome', 'noop', 'reason', 'layer_incomplete');
  end if;

  if v_layer = 0 and exists (
    select 1 from public.spell_reaction_windows
     where round_id = p_round_id and layer = 0
  ) then
    if exists (
      select 1 from public.spell_reaction_windows
       where round_id = p_round_id and layer = 0 and status = 'open'
    ) then
      return jsonb_build_object('outcome', 'noop', 'reason', 'window_open');
    end if;

    -- A closed window: the rolls were revealed when it opened.
    return public.finalize_layer(p_round_id);
  end if;

  -- First to find this Layer complete: capture its raw rolls for the reveal
  -- before any roll transform rewrites them.
  v_layer_rolls := jsonb_build_object(
    'layer', v_layer,
    'rolls', public._layer_rolls_json(p_round_id, v_layer));

  if v_layer > 0 then
    return public.finalize_layer(p_round_id)
      || jsonb_build_object('layer_rolls', v_layer_rolls);
  end if;

  perform public._forfeit_untargetable_compelled_reactions(p_round_id);

  select o.is_closed into v_window_closed
    from public.open_reaction_window(p_round_id, 0) o;

  if v_window_closed then
    v_finalization := public.finalize_layer(p_round_id);
  end if;

  return jsonb_build_object(
    'outcome', 'windowOpened',
    'layer', 0,
    'window_closed', v_window_closed,
    'finalization', v_finalization,
    'layer_rolls', v_layer_rolls);
end;
$$;

revoke execute on function public.advance_layer(uuid) from public, anon;
grant execute on function public.advance_layer(uuid) to authenticated;

comment on function public.advance_layer(uuid) is
  'Layer completion (ADR 0008, issue #415). Locks the round, then returns { outcome: "noop", reason } unless the round is closed and its current Layer is complete -- reasons: round_not_found, round_not_closed, layer_incomplete, window_open. At Layer 0 with no reaction window it opens one and returns { outcome: "windowOpened", layer: 0, window_closed, finalization, layer_rolls }, where finalization is finalize_layer''s outcome when nobody was eligible to react (the window closed on the spot) and null otherwise. At Layer 0 with a closed window, or at a Tie-Break Reroll Layer, it returns finalize_layer''s outcome ({ outcome: "brewer", ... } or { outcome: "tie", ... }). layer_rolls -- { layer, rolls: [{ player_id, value, discarded_value, entered_by_admin }] }, the raw pre-transform rolls -- is present only on the call that first finds the Layer complete. Never opens a second window; never raises for caller identity or a lost race.';
-- END db/sql/functions/advance_layer.sql

-- BEGIN db/sql/functions/cast_reaction_spell_card.sql
-- cast_reaction_spell_card(uuid, text, uuid, integer) -> uuid
--
-- Arm a spell into an open reaction window: validation, by-name dispatch,
-- contested-negate backfire draw, Cast-Log write, and a reopen-or-close of
-- the chaining poll. Body verbatim from migration
-- 0104_reaction_window_close_on_last_reaction_cast (issue #387: the 0096
-- body with its four inline poll_round bumps folded into
-- _rr_reopen_or_close_reaction_poll). revoke/grant unchanged since 0096.
-- Issue #440: every return runs _rr_finish_compelled_cast, which tags a
-- compelled Reaction holder's cast compelled_by Brewmageddon.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.cast_reaction_spell_card(
  p_round_id uuid, p_target_player_id text default null, p_target_cast_id uuid default null,
  p_spend_amount integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_casting_time text;
  v_target_stamp text;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_cast_id uuid;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_target_tier text;
  v_target_target_player text;
  v_target_group uuid;
  v_dc integer;
  v_roll integer;
  v_participant record;
  v_room_id uuid;
  v_card_name text;
  v_eff_mod integer;
  v_spend integer;
  -- issue #316: Effect Invocation (Saucerer's Apprentice / Brew-merang)
  v_src_caster text;
  v_src_group uuid;
  v_src_card_name text;
  v_src_parent uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select id into v_window_id
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'cast_reaction_spell_card: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'cast_reaction_spell_card: caller is not a participant in this round';
  end if;

  select sdi.id, sc.id, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_reaction_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'R' then
    raise exception 'cast_reaction_spell_card: only Reaction cards can be cast into a reaction window';
  end if;

  if v_target_stamp = 'CARD' then
    if p_target_cast_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target cast';
    end if;
    select casts.target_player_id, casts.card_instance_id, sc2.tier
      into v_target_target_player, v_target_group, v_target_tier
      from public.spell_casts casts
      join public.spell_deck_instances sdi2 on sdi2.id = casts.card_instance_id
      join public.spell_cards sc2 on sc2.id = sdi2.card_id
     where casts.id = p_target_cast_id and casts.round_id = p_round_id;

    if v_target_tier is null then
      raise exception 'cast_reaction_spell_card: target cast not found in this round';
    end if;
    v_final_target := null;
  elsif v_target_stamp = 'SELF' then
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target player';
    end if;
    if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
      raise exception 'cast_reaction_spell_card: this card cannot target yourself';
    end if;
    if not exists (
      select 1 from public.round_participants
       where round_id = p_round_id and player_id = p_target_player_id
    ) then
      raise exception 'cast_reaction_spell_card: target is not a participant in this round';
    end if;
  elsif v_target_stamp = 'TABLE' then
    v_final_target := null;
  else
    raise exception 'cast_reaction_spell_card: % -targeted cards cannot be cast as a reaction yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  select room_id into v_room_id from public.rounds where id = p_round_id;
  select name into v_card_name from public.spell_cards where id = v_card_id;

  -- issue #318: Brew-tal Swap (Reaction, OPPONENT) -- swap the caster's d20
  -- with the target's. Zero spell_card_effects rows, so it is a by-name
  -- branch emitting one roll_pair_transform cast (op = swap) with the pair
  -- recorded in cast_inputs; apply_roll_pair_transform runs it at
  -- reaction-window finalize and resolve_round Phase 3 adopts the result.
  -- target_role convention across the four #318 cards: 'TARGET' when a single
  -- non-caster is named (Brew-tal Swap / Steaming Mug Bond / Tea for Two),
  -- 'TABLE' when the caster names two others (Stir the Pot). The pair itself
  -- is authoritative in cast_inputs.pair; the resolver never reads target_role
  -- for these rows.
  if v_card_name = 'Brew-tal Swap' then
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target, false,
      'roll_pair_transform', jsonb_build_object('op', 'swap'),
      jsonb_build_object('pair', jsonb_build_array(v_player_id, v_final_target)),
      v_window_id, 'TARGET'
    )
    returning id into v_cast_id;

    perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
  end if;

  -- issue #316: Effect Invocation -- Saucerer's Apprentice (copy) and
  -- Brew-merang (seize). Both are CARD-targeted Reactions with NO
  -- spell_card_effects rows, so the generic loop below would burn the card for
  -- nothing. Instead emit a single effect_kind = NULL invoking row carrying a
  -- pointer in cast_inputs; resolve_round Phase 0 derives the real effect.
  if v_card_name in ('Saucerer''s Apprentice', 'Brew-merang') then
    select src.caster_id, src.card_instance_id, srcn.name, src.parent_cast_id
      into v_src_caster, v_src_group, v_src_card_name, v_src_parent
      from public.spell_casts src
      join public.spell_deck_instances srcsdi on srcsdi.id = src.card_instance_id
      join public.spell_cards srcn on srcn.id = srcsdi.card_id
     where src.id = p_target_cast_id and src.round_id = p_round_id
     limit 1;

    if v_src_caster is null then
      raise exception 'cast_reaction_spell_card: target cast not found in this round';
    end if;

    -- No meta-invocation (spec §10): invocation cards cannot invoke each other.
    if v_src_card_name in ('Saucerer''s Apprentice', 'Brew-merang', 'Genie in the Teapot') then
      raise exception 'cast_reaction_spell_card: an invocation card cannot invoke another invocation card'
        using errcode = 'RFB49';
    end if;

    -- Brew-merang seizes ANOTHER player's cast (card text: "When another
    -- player plays a card").
    if v_card_name = 'Brew-merang' and v_src_caster = v_player_id then
      raise exception 'cast_reaction_spell_card: Brew-merang can only seize another player''s cast'
        using errcode = 'RFB49';
    end if;

    if v_card_name = 'Brew-merang' then
      v_cast_inputs := jsonb_build_object('seized_cast_id', p_target_cast_id);
    else
      -- Saucerer's Apprentice: draw every fresh copy RNG now (a copied d20 /
      -- dice re-rolls, a copied eager roll cast gets a synthesised
      -- roll_transform onto this caster) so resolve_round stays pure.
      v_cast_inputs := jsonb_build_object('copied_cast_id', p_target_cast_id)
        || jsonb_build_object('copy_inputs',
             public._rr_build_copy_inputs(p_round_id, p_target_cast_id, v_player_id));
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, null, false,
      null, '{}'::jsonb, v_cast_inputs, p_target_cast_id, v_window_id, 'CARD'
    )
    returning id into v_cast_id;

    perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
  end if;

  -- issue #342: Tea-tally Spent. Spend a clamped amount of your own effective
  -- modifier durably (a persistent_modifier_spend {delta:-n} on SELF, picked
  -- up by resolve_round Phase 4b and _rr_spell_modifier_delta) and add the
  -- same amount to THIS round's roll only (a round-scoped flat_modifier
  -- {delta:+n} on SELF, composed by Phase 4a). No spell_card_effects rows.
  if v_card_name = 'Tea-tally Spent' then
    if p_spend_amount is null then
      raise exception 'cast_reaction_spell_card: Tea-tally Spent requires a spend amount'
        using errcode = 'RFB45';
    end if;

    select modifier into v_eff_mod from public.room_players
     where room_id = v_room_id and player_id = v_player_id;
    v_eff_mod := coalesce(v_eff_mod, 0);

    if v_eff_mod <= 0 then
      raise exception 'cast_reaction_spell_card: caster has no modifier to spend'
        using errcode = 'RFB44';
    end if;

    v_spend := least(greatest(p_spend_amount, 0), v_eff_mod);

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id, false,
      'persistent_modifier_spend', jsonb_build_object('delta', -v_spend),
      jsonb_build_object('spend_amount', v_spend), v_window_id, 'CASTER'
    )
    returning id into v_cast_id;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role, source_cast_id
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id, false,
      'flat_modifier', jsonb_build_object('delta', v_spend),
      jsonb_build_object('spend_amount', v_spend), v_window_id, 'CASTER', v_cast_id
    );

    perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
  end if;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id
     order by ordinal
  loop
    if v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
      and v_effect.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'forced_reroll') then
      for v_participant in
        select rp.player_id
          from public.round_participants rp
         where rp.round_id = p_round_id
           and (v_effect.target_role <> 'ALL_OTHER_PLAYERS' or rp.player_id <> v_player_id)
      loop
        -- #312: a table-wide reaction dice_modifier rolls now, into
        -- cast_inputs.dice_roll (raw, unsigned). resolve_round / the finalize
        -- shim apply the sign.
        v_cast_inputs := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_cast_inputs := jsonb_build_object('dice_roll', v_roll_total);
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_participant.player_id, false,
          v_effect.effect_kind, v_effect.effect_params, v_cast_inputs, p_target_cast_id, v_window_id, v_effect.target_role
        )
        returning id into v_row_cast_id;

        if v_cast_id is null then
          v_cast_id := v_row_cast_id;
        end if;
      end loop;

      continue;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS') then
      v_row_target := null;
    else
      v_row_target := case when v_effect.target_role = 'CASTER' then v_player_id else v_final_target end;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, false,
      v_effect.effect_kind, v_effect.effect_params, p_target_cast_id, v_window_id, v_effect.target_role
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_effect.effect_kind = 'contested_negate' then
      -- effect_params.dc (from the card's spell_card_effects row) overrides
      -- the tier default: Saving Steep {"dc": 10}, Tannin Tantrum omits it.
      v_dc := coalesce(
        (v_effect.effect_params ->> 'dc')::integer,
        public._rr_tier_default_dc(v_target_tier));
      v_roll := floor(random() * 20 + 1)::integer;

      -- The d20 is a server-RNG draw -> record it into the Cast Log
      -- (cast_inputs.dc_d20) alongside the DC it was checked against.
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                           || jsonb_build_object('dc_d20', v_roll, 'dc', v_dc)
       where id = v_row_cast_id;

      -- PROVISIONAL cache for live readers only (reaction stack, the
      -- finalize shim's negated filter, the get_round_modifier_effects
      -- preview). resolve_round Phase 1 recomputes negation recursively
      -- (counter-of-counter to any depth) and overwrites this
      -- authoritatively — for a single-level counter the two always agree.
      if v_roll >= v_dc then
        update public.spell_casts set negated = true where id = p_target_cast_id;
      end if;

      -- Natural 1 on a counter whose card carries the backfire behaviour
      -- (effect_params.backfire = true -- Saving Steep only; Tannin Tantrum
      -- omits it and just "resolves as normal" on a fail, spec §8). It does
      -- NOT negate the victim; instead resolve_round re-applies every effect
      -- row of the victim group once more onto the reactor. Draw + record
      -- every extra server-RNG that needs, now, into cast_inputs.backfire --
      -- whose presence is then the resolver's backfire signal.
      if v_roll = 1
         and v_target_group is not null
         and coalesce((v_effect.effect_params ->> 'backfire')::boolean, false) then
        perform public._rr_record_backfire(v_row_cast_id, v_target_group);
      end if;
    elsif v_effect.effect_kind = 'redirect' then
      -- #312: redirect records nothing of its own (spec §4: cast_inputs = {}).
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
       where id = v_row_cast_id;

      -- No in-place target_player_id UPDATE (spec §8). Provisional
      -- redirected_to_cast_id pointer only; resolve_round Phase 1 derives
      -- the effective post-redirect target from recorded state.
      if v_target_group is not null then
        update public.spell_casts
           set redirected_to_cast_id = v_row_cast_id
         where id = p_target_cast_id;
      end if;
    end if;
  end loop;

  perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

  return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
end;
$$;
revoke execute on function public.cast_reaction_spell_card(uuid, text, uuid, integer) from public, anon;
grant execute on function public.cast_reaction_spell_card(uuid, text, uuid, integer) to authenticated;
-- END db/sql/functions/cast_reaction_spell_card.sql

-- BEGIN db/sql/functions/cast_spell_card.sql
-- cast_spell_card(uuid, text, text[], integer, text) -> uuid
--
-- Arm a spell during the pre-roll (declare-in) window: validation,
-- by-name dispatch, WILD special-casing, Cast-Log write. Verbatim from
-- migration 0096, plus issue #440's Compelled Cast: a player who owes
-- Brewmageddon a compelled Action cast may cast while the round is `closed`
-- (the Compelled Cast step), must name any target now (no deferred target),
-- and every return runs _rr_finish_compelled_cast, which fans out the cast's
-- TABLE placeholders and tags it compelled_by.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.cast_spell_card(
  p_round_id uuid, p_target_player_id text default null,
  p_chosen_player_ids text[] default null, p_declared_number integer default null,
  p_invoked_card_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_card_name text;
  v_casting_time text;
  v_target_stamp text;
  v_target_pending boolean := false;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_pending boolean;
  v_row_cast_id uuid;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_effect_params jsonb;
  v_max_targets integer;
  v_chosen_id text;
  v_branch integer;
  v_other_id text;
  v_extreme_low text;
  v_extreme_high text;
  v_target_mod integer;
  v_snap integer;
  v_caster_mod integer;
  -- issue #344: ward interaction for modifier-transfer / snapshot cards
  v_ward_cast_id uuid;
  v_ward_card_name text;
  v_ward_blocked boolean := false;
  v_loser text;
  v_wb_before integer;
  v_wb_after integer;
  v_block_marker jsonb;
  -- issue #316: Genie in the Teapot (Effect Invocation)
  v_is_genie boolean := false;
  v_gen_card_id uuid;
  v_gen_casting_time text;
  v_gen_tier text;
  v_gen_target_stamp text;
  v_gen_in_deck integer;
  -- issue #440: a compelled cast made in the Compelled Cast step
  v_compelled boolean := false;
  -- issue #438: Tea Heist's pinned card
  v_stolen_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'cast_spell_card: round not found';
  end if;

  if v_status = 'closed' then
    v_compelled := public._owes_compelled_action_cast(p_round_id, v_player_id);
  end if;

  if v_status <> 'open' and not v_compelled then
    raise exception 'cast_spell_card: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'cast_spell_card: caller is not a participant in this round';
  end if;

  select sdi.id, sc.id, sc.name, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_card_name, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'cast_spell_card: only Action cards can be cast pre-roll';
  end if;

  -- issue #316: Genie in the Teapot (Effect Invocation). Name any OTHER
  -- non-Epic Action card whose sole edition instance is in_deck and resolve
  -- its effect as if played. The named instance is NOT moved (ethereal). The
  -- Genie's own held instance IS consumed. Implemented by rebinding v_card_id
  -- / v_target_stamp to the named card and falling through to the generic
  -- per-effect loop; the Genie's rows carry cast_inputs.invoked_card. A card
  -- Genie cannot express (no non-WILD effect rows, or a by-name special-case)
  -- is a typed RFB50, never a silent burn.
  if v_card_name = 'Genie in the Teapot' then
    if p_invoked_card_name is null then
      raise exception 'cast_spell_card: Genie in the Teapot must name a card'
        using errcode = 'RFB50';
    end if;

    select sc.id, sc.casting_time, sc.tier, sc.target
      into v_gen_card_id, v_gen_casting_time, v_gen_tier, v_gen_target_stamp
      from public.spell_cards sc
     where sc.name = p_invoked_card_name;

    if v_gen_card_id is null then
      raise exception 'cast_spell_card: no card named %', p_invoked_card_name
        using errcode = 'RFB50';
    end if;
    if p_invoked_card_name = 'Genie in the Teapot'
       or v_gen_tier = 'epic'
       or v_gen_casting_time <> 'A' then
      raise exception 'cast_spell_card: Genie can only name a non-Epic Action card'
        using errcode = 'RFB50';
    end if;
    -- Cards cast_spell_card resolves through a bespoke by-name / WILD branch
    -- rather than the generic per-effect loop cannot be invoked this way in
    -- this slice: their real behaviour needs live-modifier snapshots or d6
    -- dispatch the loop can't express, and "no card silently no-ops" (spec
    -- #302) beats a technically-legal-but-inert invocation. This list mirrors
    -- the name-keyed branches earlier in this function + the #342/#343 ones --
    -- keep it in sync if another by-name special-case is added.
    if p_invoked_card_name in (
         'Bes-Tea', 'Tea Leaf', 'Spillage', 'Chai-nge of Heart', 'Bitter Leech',
         'Tea Heist', 'Wild Brew Surge', 'Kettle Crash')
       or v_gen_target_stamp = 'WILD' then
      raise exception 'cast_spell_card: % cannot be invoked by Genie yet', p_invoked_card_name
        using errcode = 'RFB50';
    end if;
    if not exists (
      select 1 from public.spell_card_effects
       where card_id = v_gen_card_id and target_role <> 'WILD'
    ) then
      raise exception 'cast_spell_card: % has no invokable effect', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    -- The named card's sole edition instance must be available in the deck
    -- (held / pending_swap => not nameable). Ethereal: not consumed, not moved.
    select count(*) filter (where location = 'in_deck')
      into v_gen_in_deck
      from public.spell_deck_instances
     where card_id = v_gen_card_id;
    if coalesce(v_gen_in_deck, 0) < 1 then
      raise exception 'cast_spell_card: % is not available in the deck', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    -- Genie picks the target now, following the named card's own rule.
    if v_gen_target_stamp in ('OPPONENT', 'PLAYER') and p_target_player_id is null then
      raise exception 'cast_spell_card: Genie must choose the target for % now', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    v_is_genie := true;
    v_card_id := v_gen_card_id;
    v_target_stamp := v_gen_target_stamp;
  end if;

  if v_target_stamp = 'SELF' then
    if p_target_player_id is not null and p_target_player_id <> v_player_id then
      raise exception 'cast_spell_card: this card can only target yourself';
    end if;
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      v_target_pending := true;
      v_final_target := null;
    else
      if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
        raise exception 'cast_spell_card: this card cannot target yourself';
      end if;
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = p_target_player_id
      ) then
        raise exception 'cast_spell_card: target is not a participant in this round';
      end if;
    end if;
  elsif v_target_stamp = 'CHOSEN_PLAYERS' then
    if p_chosen_player_ids is null or array_length(p_chosen_player_ids, 1) is null then
      raise exception 'cast_spell_card: this card requires at least one chosen player';
    end if;
    if array_length(p_chosen_player_ids, 1) <> (
      select count(distinct x) from unnest(p_chosen_player_ids) x
    ) then
      raise exception 'cast_spell_card: chosen players must be distinct';
    end if;
    foreach v_chosen_id in array p_chosen_player_ids loop
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = v_chosen_id
      ) then
        raise exception 'cast_spell_card: chosen player is not a participant in this round';
      end if;
    end loop;
  elsif v_target_stamp in ('TABLE', 'WILD') then
    v_final_target := null;
  else
    raise exception 'cast_spell_card: % -targeted cards cannot be cast pre-roll yet', v_target_stamp;
  end if;

  -- issue #440: every participant is already known in the Compelled Cast
  -- step, so a compelled cast names its target now -- no deferred target,
  -- and a WILD card names its possible tea-maker before its d6 is rolled.
  if v_compelled then
    if v_target_pending or (v_target_stamp = 'WILD' and p_target_player_id is null) then
      raise exception 'cast_spell_card: a compelled cast must name its target now'
        using errcode = 'RFB55';
    end if;
    if v_target_stamp = 'WILD' then
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = p_target_player_id
      ) then
        raise exception 'cast_spell_card: target is not a participant in this round';
      end if;
    end if;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  -- issue #318: chosen-pair roll transform Action cards. Zero
  -- spell_card_effects rows, so each is a by-name branch emitting one
  -- roll_pair_transform cast; apply_roll_pair_transform runs it at
  -- reaction-window finalize (its pre-roll rows are attached to the layer-0
  -- window by attach_pre_roll_roll_pair_transform_casts, migration 0096) and
  -- resolve_round Phase 3 adopts the result. No deferred-target path this
  -- slice -- an explicit target / pair is required at cast time (RFB46), the
  -- Bes-Tea / Chai-nge of Heart tradeoff.
  --   * Stir the Pot      -- op = swap over two OTHER players (never caster)
  --   * Steaming Mug Bond  -- op = min: caster + target both take the lower d20
  --   * Tea for Two        -- op = max: caster + target both take the higher d20
  if v_card_name in ('Stir the Pot', 'Steaming Mug Bond', 'Tea for Two') then
    if v_card_name = 'Stir the Pot' then
      if coalesce(array_length(p_chosen_player_ids, 1), 0) <> 2 then
        raise exception 'cast_spell_card: Stir the Pot requires exactly two chosen players'
          using errcode = 'RFB46';
      end if;
      if p_chosen_player_ids[1] = p_chosen_player_ids[2] then
        raise exception 'cast_spell_card: chosen players must be distinct'
          using errcode = 'RFB46';
      end if;
      if v_player_id = any (p_chosen_player_ids) then
        raise exception 'cast_spell_card: Stir the Pot cannot choose yourself'
          using errcode = 'RFB46';
      end if;
      foreach v_chosen_id in array p_chosen_player_ids loop
        if not exists (
          select 1 from public.round_participants
           where round_id = p_round_id and player_id = v_chosen_id
        ) then
          raise exception 'cast_spell_card: chosen player is not a participant in this round'
            using errcode = 'RFB46';
        end if;
      end loop;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, false,
        'roll_pair_transform', jsonb_build_object('op', 'swap'),
        jsonb_build_object('pair',
          jsonb_build_array(p_chosen_player_ids[1], p_chosen_player_ids[2])),
        'TABLE'
      )
      returning id into v_cast_id;
    else
      if v_final_target is null then
        raise exception 'cast_spell_card: % requires an explicit target', v_card_name
          using errcode = 'RFB46';
      end if;
      if v_final_target = v_player_id then
        raise exception 'cast_spell_card: this card cannot target yourself'
          using errcode = 'RFB46';
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'roll_pair_transform',
        jsonb_build_object('op',
          case v_card_name when 'Steaming Mug Bond' then 'min' else 'max' end),
        jsonb_build_object('pair', jsonb_build_array(v_player_id, v_final_target)),
        'TARGET'
      )
      returning id into v_cast_id;
    end if;

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
  end if;

  -- issue #343: round-scoped modifier snapshot cards. Fully special-cased
  -- (like WILD / Kettle Crash / declared_number_tea_maker) because the
  -- generic per-effect loop can only copy static spell_card_effects params
  -- and these cards need a value computed from live modifiers at cast time.
  -- The rows emitted here carry no duration and no spell_active_effects
  -- row, so resolve_round Phase 4a composes them for THIS round only and
  -- they revert automatically at round end.
  if v_card_name in ('Bes-Tea', 'Tea Leaf', 'Spillage') then
    if v_final_target is null then
      raise exception 'cast_spell_card: this card requires a target chosen at cast time';
    end if;

    select coalesce(modifier, 0) into v_target_mod
      from public.room_players
     where room_id = v_room_id and player_id = v_final_target;
    v_target_mod := coalesce(v_target_mod, 0);

    -- issue #344: ward interaction. Bes-Tea's copy fails against a block_copy
    -- holder; Tea Leaf / Spillage's steal is blocked atomically -- the target
    -- keeps their modifier AND the caster gets no roll bonus -- when the
    -- target holds a matching negative modifier-domain ward. The card is still
    -- spent (the deck instance was returned above); the emitted rows go in
    -- negated with a _rr_ward_block_marker that resolve_round's Pre-pass turns
    -- into one `warded` step. Detection is at cast time: like Bes-Tea's own
    -- source_modifier snapshot these Action cards resolve their inputs when
    -- cast, so a ward cast later the same round (higher seq) does not gate.
    v_ward_blocked := false;
    v_ward_cast_id := null;
    v_ward_card_name := null;
    v_block_marker := '{}'::jsonb;

    if v_card_name = 'Bes-Tea' then
      select sae.source_cast_id, scw.name
        into v_ward_cast_id, v_ward_card_name
        from public.spell_active_effects sae
        join public.spell_cards scw on scw.id = sae.card_id
       where sae.room_id = v_room_id
         and sae.target_player_id = v_final_target
         and sae.effect_kind = 'ward'
         and coalesce((sae.effect_params ->> 'block_copy')::boolean, false) = true
       order by sae.created_at
       limit 1;
      v_ward_blocked := found;
      if v_ward_blocked then
        -- ward_target is the block_copy holder (v_final_target), so the Trace
        -- sentence names the ward holder; the would-be values describe the
        -- caster's round modifier the copy would have set.
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target,
          coalesce((select modifier from public.room_players
                     where room_id = v_room_id and player_id = v_player_id), 0),
          v_target_mod);
      end if;

      -- Copy the target's effective modifier onto the caster for this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'set_modifier', jsonb_build_object('value', v_target_mod),
        jsonb_build_object('source_modifier', v_target_mod) || v_block_marker,
        'CASTER', v_ward_blocked
      )
      returning id into v_cast_id;

    elsif v_card_name = 'Tea Leaf' then
      if v_target_mod > 0 then
        select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
          from public._rr_active_ward_gate(
            v_room_id, v_final_target, 'modifier', 'negative', p_round_id, null) g;
        v_ward_blocked := found;
      end if;
      if v_ward_blocked then
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target, v_target_mod, 0);
      end if;

      -- Target's modifier drops to 0 for this round...
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'set_modifier', jsonb_build_object('value', 0),
        jsonb_build_object('stolen_amount', v_target_mod) || v_block_marker,
        'TARGET', v_ward_blocked
      )
      returning id into v_cast_id;

      -- ...and the stolen amount is added to the caster's roll this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_target_mod),
        jsonb_build_object('stolen_amount', v_target_mod), 'CASTER', v_ward_blocked
      );

    else
      -- Spillage: floor(m/2) leaves the target and joins the caster's roll
      -- for this round. Postgres integer division truncates toward zero, so
      -- compute the floor explicitly for negative modifiers.
      v_snap := floor(v_target_mod / 2.0)::integer;

      if v_snap > 0 then
        select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
          from public._rr_active_ward_gate(
            v_room_id, v_final_target, 'modifier', 'negative', p_round_id, null) g;
        v_ward_blocked := found;
      end if;
      if v_ward_blocked then
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target,
          v_target_mod, v_target_mod - v_snap);
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'flat_modifier', jsonb_build_object('delta', -v_snap),
        jsonb_build_object('stolen_amount', v_snap) || v_block_marker,
        'TARGET', v_ward_blocked
      )
      returning id into v_cast_id;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_snap),
        jsonb_build_object('stolen_amount', v_snap), 'CASTER', v_ward_blocked
      );
    end if;

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
  end if;

  -- issue #342: two durable persistent-modifier cards whose emission the
  -- generic spell_card_effects loop cannot express (they carry no effect
  -- rows). Both are Action / OPPONENT and need an explicit target at cast
  -- time (RFB46) -- no deferred-target path in this slice. v_card_name is
  -- already populated from the held-card lookup above (#343).
  if v_card_name = 'Chai-nge of Heart' then
    if v_final_target is null then
      raise exception 'cast_spell_card: Chai-nge of Heart requires an explicit target'
        using errcode = 'RFB46';
    end if;

    select modifier into v_caster_mod from public.room_players
     where room_id = v_room_id and player_id = v_player_id;
    select modifier into v_target_mod from public.room_players
     where room_id = v_room_id and player_id = v_final_target;
    v_caster_mod := coalesce(v_caster_mod, 0);
    v_target_mod := coalesce(v_target_mod, 0);

    -- issue #344: ward interaction. A swap is atomic -- if the side that LOSES
    -- modifier holds a matching negative modifier-domain ward (Eternal Steep /
    -- Bag for Life / Cast-Iron Kettle) the whole transfer is blocked: both
    -- sibling rows go in negated, so Phase 4b's running-sum filter drops them
    -- while its target gather still reverts both caches to base. The card is
    -- still spent. resolve_round's Pre-pass turns the marker into one `warded`
    -- step. A ward cast later this round (higher seq) does not gate.
    v_ward_blocked := false;
    v_ward_cast_id := null;
    v_ward_card_name := null;
    v_block_marker := '{}'::jsonb;
    -- The caster's transfer row is delta = target_mod - caster_mod, so the
    -- caster is the losing side when target_mod < caster_mod (and vice versa).
    if v_target_mod < v_caster_mod then
      v_loser := v_player_id;    v_wb_before := v_caster_mod; v_wb_after := v_target_mod;
    elsif v_caster_mod < v_target_mod then
      v_loser := v_final_target; v_wb_before := v_target_mod; v_wb_after := v_caster_mod;
    else
      v_loser := null;   -- equal modifiers: the swap moves nothing
    end if;

    if v_loser is not null then
      select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
        from public._rr_active_ward_gate(
          v_room_id, v_loser, 'modifier', 'negative', p_round_id, null) g;
      v_ward_blocked := found;
    end if;
    if v_ward_blocked then
      v_block_marker := public._rr_ward_block_marker(
        v_ward_cast_id, v_ward_card_name, v_loser, v_wb_before, v_wb_after);
    end if;

    -- Sibling persistent_modifier_transfer pair: caster gains (target - caster),
    -- target gains (caster - target) -> their effective modifiers swap for the
    -- rest of the day. resolve_round Phase 4b projects both into
    -- room_players.modifier; whole-cast negation (shared card_instance_id)
    -- drops both. cast_inputs snapshots both effective modifiers at cast time.
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, negated
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_target_mod - v_caster_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod) || v_block_marker,
      v_ward_blocked
    )
    returning id into v_cast_id;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, negated
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_caster_mod - v_target_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod),
      v_cast_id, v_ward_blocked
    );

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);

  elsif v_card_name = 'Bitter Leech' then
    if v_final_target is null then
      raise exception 'cast_spell_card: Bitter Leech requires an explicit target'
        using errcode = 'RFB46';
    end if;

    -- One anchor cast + one spell_active_effects row (rounds_remaining => 3
    -- from the card's duration_rounds). resolve_round Phase 4b-pre projects a
    -- -1 / +1 persistent_modifier_transfer pair off it every round it is live
    -- (cast round + next 2). The anchor carries no 'delta' key, so it never
    -- contributes to _rr_spell_modifier_delta on its own.
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'persistent_modifier_transfer',
      jsonb_build_object('per_round_delta', 1, 'direction', 'caster_gains'),
      '{}'::jsonb
    )
    returning id into v_cast_id;

    perform public.record_active_effect_if_persistent(
      v_room_id, v_player_id, v_final_target, v_card_id,
      'persistent_modifier_transfer',
      jsonb_build_object('per_round_delta', 1, 'direction', 'caster_gains'),
      v_cast_id
    );

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);

  elsif v_card_name = 'Tea Heist' then
    -- issue #438: pin the victim's held card now (never a pending_swap one);
    -- it only moves when the round finalizes (finalize_layer ->
    -- _rr_apply_heists), and only if the Heist survives and the victim still
    -- holds it. The picker lists only card-holders (get_heist_targets); this
    -- re-checks. The thief's own hand is empty now -- Tea Heist was its card.
    if v_final_target is null then
      raise exception 'cast_spell_card: Tea Heist requires an explicit target'
        using errcode = 'RFB46';
    end if;

    select id into v_stolen_id
      from public.spell_deck_instances
     where held_by_player = v_final_target and location = 'held';

    if v_stolen_id is null then
      raise exception 'cast_spell_card: that player is not holding a card to steal'
        using errcode = 'RFB53';
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'card_heist', '{}'::jsonb,
      jsonb_build_object('stolen_instance_id', v_stolen_id),
      'TARGET'
    )
    returning id into v_cast_id;

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
  end if;

  -- WILD is fully special-cased: the six branches are mutually exclusive
  -- alternatives chosen by a d6 roll at cast time, not simultaneous
  -- spell_card_effects rows, so this bypasses the generic per-effect loop
  -- below entirely (that loop explicitly excludes target_role = 'WILD').
  if v_target_stamp = 'WILD' then
    v_branch := floor(random() * 6 + 1)::integer;

    if v_branch = 1 then
      update public.room_players set modifier = 0 where room_id = v_room_id;
      v_effect_params := '{}'::jsonb;
    elsif v_branch = 2 then
      -- issue #311: +3 caster rest of day -> a one-sided
      -- persistent_modifier_transfer the resolver's Phase 4b projects into
      -- room_players.modifier at resolve. No imperative write here.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id,
        effect_kind, effect_params, cast_inputs
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id,
        'persistent_modifier_transfer', jsonb_build_object('delta', 3), '{}'::jsonb
      );
      v_effect_params := '{"delta": 3}'::jsonb;
    elsif v_branch = 3 then
      select player_id into v_other_id
        from public.room_players
       where room_id = v_room_id and player_id <> v_player_id
       order by random()
       limit 1;
      if v_other_id is not null then
        -- issue #311: modifier swap -> a persistent_modifier_transfer sibling
        -- pair with a cast-time snapshot; the resolver's Phase 4b projects
        -- both sides. swap_room_player_modifiers is retired.
        perform public._rr_emit_modifier_swap_pair(
          v_room_id, p_round_id, v_player_id, v_instance_id, v_player_id, v_other_id
        );
        v_effect_params := jsonb_build_object('swapped_with', v_other_id);
      else
        v_effect_params := '{}'::jsonb;
      end if;
    elsif v_branch = 4 then
      -- "Everyone rerolls" — nobody's rolled yet (WBS is cast pre-roll), so
      -- this arms a table-wide forced_reroll placeholder the same as Tea-M
      -- Reroll, fanned out to the final roster by close_round below and
      -- applied once the round's first rolls are in (finalizeReactionWindow
      -- already applies any un-negated forced_reroll cast for the layer,
      -- regardless of whether it was armed pre-roll or as a reaction).
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, true,
        'forced_reroll', '{}'::jsonb, 'TABLE'
      );
      v_effect_params := '{}'::jsonb;
    elsif v_branch = 5 then
      select rp.player_id into v_extreme_high
        from public.round_participants rp
        join public.room_players rpl on rpl.room_id = v_room_id and rpl.player_id = rp.player_id
       where rp.round_id = p_round_id
       order by rpl.modifier desc, rp.player_id
       limit 1;
      select rp.player_id into v_extreme_low
        from public.round_participants rp
        join public.room_players rpl on rpl.room_id = v_room_id and rpl.player_id = rp.player_id
       where rp.round_id = p_round_id
       order by rpl.modifier asc, rp.player_id
       limit 1;
      if v_extreme_high is not null and v_extreme_low is not null and v_extreme_high <> v_extreme_low then
        -- issue #311: highest <-> lowest modifier swap -> a
        -- persistent_modifier_transfer sibling pair with a cast-time snapshot.
        perform public._rr_emit_modifier_swap_pair(
          v_room_id, p_round_id, v_player_id, v_instance_id, v_extreme_high, v_extreme_low
        );
        v_effect_params := jsonb_build_object('swapped', jsonb_build_array(v_extreme_high, v_extreme_low));
      else
        v_effect_params := '{}'::jsonb;
      end if;
    else
      -- Branch 6: choose who makes tea this round. p_target_player_id may
      -- already be known (client asked up front); otherwise this defers the
      -- same way OPPONENT/PLAYER cards do, and the caster fills it in later
      -- via set_spell_cast_target once the round closes.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, p_target_player_id, p_target_player_id is null,
        'tea_maker_override', '{"mode": "chosen"}'::jsonb, 'WILD'
      )
      returning id into v_cast_id;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id,
        effect_kind, effect_params, cast_inputs
      )
      values (p_round_id, v_player_id, v_instance_id, null,
              'wild_dispatch', '{"branch": 6}'::jsonb, jsonb_build_object('branch', v_branch));

      return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs
    )
    values (p_round_id, v_player_id, v_instance_id, null,
            'wild_dispatch', v_effect_params, jsonb_build_object('branch', v_branch))
    returning id into v_cast_id;

    return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
  end if;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id and target_role <> 'WILD'
     order by ordinal
  loop
    v_effect_params := v_effect.effect_params;

    if v_effect.effect_kind = 'declared_number_tea_maker' then
      if p_declared_number is null or p_declared_number < 1 or p_declared_number > 20 then
        raise exception 'cast_spell_card: this card requires a declared number between 1 and 20';
      end if;
      v_effect_params := jsonb_build_object('number', p_declared_number);

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

      -- #310: Cast Log row first so the sentinel active-effect row can carry a
      -- real source_cast_id (spell_active_effects.source_cast_id is NOT NULL).
      -- rounds_remaining => 1: the declared number applies to its own cast
      -- round only, then _rr_active_effects_as_of derives it expired -- no
      -- physical DELETE (#310).
      insert into public.spell_active_effects (
        room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining
      )
      values (v_room_id, v_player_id, v_player_id, v_row_cast_id, v_card_id, v_effect.effect_kind, v_effect_params, 1);

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    end if;

    if v_effect.target_role = 'CASTER' then
      v_row_target := v_player_id;
      v_row_pending := false;
    elsif v_effect.target_role = 'TARGET' then
      v_row_target := v_final_target;
      v_row_pending := v_target_pending;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
      and v_effect.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'forced_reroll') then
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, true,
        v_effect.effect_kind, v_effect_params, v_effect.target_role
      )
      returning id into v_row_cast_id;

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS') then
      -- Single table-wide event (roll_swap/roll_flip/lowest_gains_highest_
      -- modifier/tea_maker_override) — no per-player row needed.
      if v_effect.effect_kind = 'reset_persistent_modifier' then
        -- Kettle Crash (#285, migration 0076): persistent, not round-scoped,
        -- so apply the reset live at cast time — no close_round fan-out. The
        -- spell_casts insert just below is the audit trail.
        update public.room_players set modifier = 0 where room_id = v_room_id;
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    elsif v_effect.target_role = 'CHOSEN_PLAYERS' then
      v_max_targets := coalesce((v_effect_params ->> 'max_targets')::integer, array_length(p_chosen_player_ids, 1));
      if array_length(p_chosen_player_ids, 1) > v_max_targets then
        raise exception 'cast_spell_card: this card can only target up to % players', v_max_targets;
      end if;

      foreach v_chosen_id in array p_chosen_player_ids loop
        -- #312: a CHOSEN_PLAYERS dice_modifier rolls immediately at cast time
        -- (unlike a CASTER/TARGET one, which defers to a Pending Spell Die).
        -- The raw, unsigned total is recorded into cast_inputs.dice_roll;
        -- its presence keeps this cast out of get_my_pending_spell_dice --
        -- the role a non-null resolved_value used to play.
        v_cast_inputs := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_cast_inputs := jsonb_build_object('dice_roll', v_roll_total);
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_chosen_id, false,
          v_effect.effect_kind, v_effect_params, v_cast_inputs, v_effect.target_role
        )
        returning id into v_row_cast_id;

        if v_cast_id is null then
          v_cast_id := v_row_cast_id;
        end if;

        perform public.record_active_effect_if_persistent(
          v_room_id, v_player_id, v_chosen_id, v_card_id,
          v_effect.effect_kind, v_effect_params, v_row_cast_id
        );
      end loop;

      continue;
    else
      v_row_target := v_final_target;
      v_row_pending := v_target_pending;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, v_row_pending,
      v_effect.effect_kind, v_effect_params, v_effect.target_role
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_row_target is not null then
      perform public.record_active_effect_if_persistent(
        v_room_id, v_player_id, v_row_target, v_card_id,
        v_effect.effect_kind, v_effect_params, v_row_cast_id
      );
    end if;
  end loop;

  -- issue #316: tag every row the Genie emitted with the card it invoked, so
  -- the Cast Log / Recap show it resolved "as if you had played" that card.
  if v_is_genie then
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                         || jsonb_build_object('invoked_card', p_invoked_card_name)
     where round_id = p_round_id
       and card_instance_id = v_instance_id
       and caster_id = v_player_id;
  end if;

  return public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, v_cast_id);
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text, text[], integer, text) from public, anon;
grant execute on function public.cast_spell_card(uuid, text, text[], integer, text) to authenticated;
-- END db/sql/functions/cast_spell_card.sql

-- BEGIN db/sql/functions/close_round.sql
-- close_round(p_round_id uuid) -> void
--
-- Lock the roster and fan out a caster's TABLE / ALL_OTHER_PLAYERS
-- placeholder casts into one real spell_casts row per participant
-- (_fan_out_table_placeholder_casts, lifted out of this body unchanged in
-- issue #440), then fix Brewmageddon's compelled set (_fix_compelled_set).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.close_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_started_by text;
  v_declared_count integer;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, started_by, room_id into v_status, v_started_by, v_room_id
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'close_round: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'close_round: round is not open';
  end if;

  if v_started_by <> v_player_id then
    raise exception 'close_round: only the round starter can close declarations';
  end if;

  select count(*) into v_declared_count
    from public.round_participants
   where round_id = p_round_id;

  if v_declared_count < 2 then
    raise exception 'close_round: at least 2 players must declare in before closing';
  end if;

  update public.rounds set status = 'closed', closed_at = now() where id = p_round_id;

  -- TABLE / ALL_OTHER_PLAYERS placeholders fan out against the final roster.
  perform public._fan_out_table_placeholder_casts(p_round_id);

  -- Issue #440: fix Brewmageddon's compelled set now the roster is locked,
  -- which starts the Compelled Cast step (rolling is held until every
  -- compelled Action cast is in) and forfeits any card with no legal target.
  perform public._fix_compelled_set(p_round_id);
end;
$$;

revoke execute on function public.close_round(uuid) from public, anon;
grant execute on function public.close_round(uuid) to authenticated;
-- END db/sql/functions/close_round.sql

-- BEGIN db/sql/functions/end_active_effect.sql
-- end_active_effect
--
-- A Detox (dispel) is played through its own RPC; a compelled Detox holder
-- plays it in the Compelled Cast step like any other Action card. Otherwise
-- unchanged (0084).
create or replace function public.end_active_effect(p_round_id uuid, p_effect_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_instance_id uuid;
  v_casting_time text;
  v_effect_kind text;
  v_effect_params jsonb;
  v_tiers text[];
  v_target_player_id text;
  v_target_tier text;
  v_target_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'end_active_effect: round not found';
  end if;

  if v_status <> 'open'
     and not (v_status = 'closed' and public._owes_compelled_action_cast(p_round_id, v_player_id)) then
    raise exception 'end_active_effect: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  select gh.instance_id, gh.casting_time, gh.effect_kind, gh.effect_params
    into v_instance_id, v_casting_time, v_effect_kind, v_effect_params
    from public.get_held_card_effect(v_player_id) gh;

  if v_instance_id is null then
    raise exception 'end_active_effect: caller is not holding a card';
  end if;

  if v_effect_kind <> 'dispel' then
    raise exception 'end_active_effect: held card cannot end active effects';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'end_active_effect: only Action cards can be cast pre-roll';
  end if;

  select array(select jsonb_array_elements_text(v_effect_params -> 'tiers')) into v_tiers;

  select sae.target_player_id, sc2.tier, sae.room_id
    into v_target_player_id, v_target_tier, v_target_room_id
    from public.spell_active_effects sae
    join public.spell_cards sc2 on sc2.id = sae.card_id
   where sae.id = p_effect_id;

  if v_target_player_id is null then
    raise exception 'end_active_effect: active effect not found';
  end if;

  if v_target_room_id <> v_room_id then
    raise exception 'end_active_effect: active effect is not in this room';
  end if;

  if not (v_target_tier = any(v_tiers)) then
    raise exception 'end_active_effect: held card cannot end a % effect', v_target_tier;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params
  )
  values (
    p_round_id, v_player_id, v_instance_id, v_target_player_id, 'dispel',
    jsonb_build_object('ended_effect_id', p_effect_id)
  );

  perform public._rr_finish_compelled_cast(p_round_id, v_player_id, v_instance_id, null);
end;
$$;
-- END db/sql/functions/end_active_effect.sql

-- BEGIN db/sql/functions/exclude_round_participant.sql
-- exclude_round_participant
--
-- Exclusion for never rolling forfeits the player's outstanding compelled
-- cast (a Reaction holder who never rolled never reached the window).
-- Otherwise unchanged (0009).
create or replace function public.exclude_round_participant(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    update public.round_participants
       set excluded_at = now()
     where round_id = p_round_id and player_id = p_player_id and excluded_at is null;

    perform public._forfeit_compelled_card(p_round_id, p_player_id, 'excluded');
  else
    update public.round_layer_participants
       set excluded_at = now()
     where round_id = p_round_id and layer = p_layer and player_id = p_player_id
       and excluded_at is null;
  end if;
end;
$$;
-- END db/sql/functions/exclude_round_participant.sql

-- BEGIN db/sql/functions/forfeit_stalled_compelled_casts.sql
-- forfeit_stalled_compelled_casts
--
-- The stall clock's Compelled Cast branch: forfeits every compelled Action
-- cast still owed, which ends the step and lets rolling open. Returns who
-- forfeited. enforceStallTimeout (src/app/rounds/stallEnforcement.ts)
-- decides that STALL_TIMEOUT_MS has passed before calling this, like every
-- other stall RPC.
create or replace function public.forfeit_stalled_compelled_casts(p_round_id uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_forfeited text[] := '{}';
  v_player_id text;
begin
  perform 1 from public.rounds where id = p_round_id for update;

  for v_player_id in
    select o.player_id from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
     order by o.player_id
  loop
    if public._forfeit_compelled_card(p_round_id, v_player_id, 'stall') then
      v_forfeited := v_forfeited || v_player_id;
    end if;
  end loop;

  return v_forfeited;
end;
$$;

revoke execute on function public.forfeit_stalled_compelled_casts(uuid) from public, anon;
grant execute on function public.forfeit_stalled_compelled_casts(uuid) to authenticated;
-- END db/sql/functions/forfeit_stalled_compelled_casts.sql

-- BEGIN db/sql/functions/get_compelled_cast_step.sql
-- get_compelled_cast_step
--
-- The Compelled Cast step as the table sees it: who still owes an Action
-- cast (rolling is held while this is non-empty), and when the step ended --
-- the last compelled Action cast or Forfeit -- or null when the round had no
-- step. Layer 0's roll stall clock runs from ended_at when there is one, so
-- a long step never counts against the rollers.
create or replace function public.get_compelled_cast_step(p_round_id uuid)
returns table (waiting_on text[], ended_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(array(
      select o.player_id from public._compelled_outstanding(p_round_id) o
       where o.casting_time = 'A'
       order by o.player_id), '{}'::text[]),
    (select max(c.cast_at)
       from public.spell_casts c
      where c.round_id = p_round_id
        and c.reaction_window_id is null
        and c.cast_inputs ? 'compelled_by'
        and (c.effect_kind is distinct from 'forfeit' or c.cast_inputs ->> 'casting_time' = 'A'));
$$;

revoke execute on function public.get_compelled_cast_step(uuid) from public, anon;
grant execute on function public.get_compelled_cast_step(uuid) to authenticated;
-- END db/sql/functions/get_compelled_cast_step.sql

-- BEGIN db/sql/functions/get_my_compelled_cast.sql
-- get_my_compelled_cast
--
-- The caller's own outstanding compelled cast, for the prompt: which card,
-- whether it is an Action (cast now) or a Reaction (cast in the window), and
-- who played Brewmageddon. No row when the caller owes nothing.
create or replace function public.get_my_compelled_cast(p_round_id uuid)
returns table (casting_time text, card_name text, brewmageddon_caster_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select o.casting_time, sc.name, bm.caster_id
      from public._compelled_outstanding(p_round_id) o
      join public.spell_deck_instances sdi on sdi.id = o.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
      join public.spell_casts bm on bm.id = o.brewmageddon_cast_id
     where o.player_id = v_player_id;
end;
$$;

revoke execute on function public.get_my_compelled_cast(uuid) from public, anon;
grant execute on function public.get_my_compelled_cast(uuid) to authenticated;
-- END db/sql/functions/get_my_compelled_cast.sql

-- BEGIN db/sql/functions/get_reaction_stack.sql
-- get_reaction_stack
--
-- The reaction stack also carries the round's Brewmageddon cast while a
-- window is open: it is always a legal CARD target (#385), and a compelled
-- CARD-target Reaction holder must be able to pick it even when no cast is
-- attached to the window. Otherwise unchanged (0021).
create or replace function public.get_reaction_stack(p_round_id uuid)
returns table (
  cast_id uuid, card_name text, caster_id text, caster_name text,
  target_stamp text, negated boolean, parent_cast_id uuid, seq bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select casts.id, sc.name, casts.caster_id, coalesce(p.display_name, p.email),
      sc.target, casts.negated, casts.parent_cast_id, casts.seq
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
      join public.players p on p.id = casts.caster_id
      left join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where (w.round_id = p_round_id and w.status = 'open')
        or (casts.round_id = p_round_id
            and casts.effect_kind = 'compel_cast'
            and exists (
              select 1 from public.spell_reaction_windows ow
               where ow.round_id = p_round_id and ow.status = 'open'))
     order by casts.seq asc;
end;
$$;
-- END db/sql/functions/get_reaction_stack.sql

-- BEGIN db/sql/functions/get_round_recap.sql
-- get_round_recap(p_round_id uuid) -> jsonb
--
-- Round Recap read surface (issue #314, "the Ledger") + round-replay follow-up
-- (issue #352) + roll rows from the resolver (spec #402, ADR 0007): one
-- room-member-gated RPC that hands the client everything RoundReveal needs in a
-- single round trip -- the Resolution Trace and Resolution Summary (stored, or
-- the Provisional Recap's dry run while the round is live), the round's full
-- cast list with each cast's phase and coarse live state, its revealed layer
-- rolls and tie-break participants, and every scrapped replay generation's
-- retained Recap payload.
--
-- Leaves no writes: the provisional path calls _rr_resolve, whose writes all
-- roll back. spell_casts still has no direct SELECT policy (0019), so this
-- SECURITY DEFINER function is the read path.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_round_recap(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_trace jsonb;
  v_summary jsonb;
  v_provisional boolean := false;
  v_dry jsonb;
  v_casts jsonb;
  v_scrapped jsonb;
  v_layers jsonb;
  v_layer_participants jsonb;
  v_reaction_skips jsonb;
begin
  v_player_id := public.current_player_id(p_round_id);

  select r.status, r.room_id, r.current_layer,
         coalesce(r.resolution_trace, '[]'::jsonb),
         r.resolution_summary,
         coalesce(r.scrapped_generations, '[]'::jsonb)
    into v_status, v_room_id, v_layer, v_trace, v_summary, v_scrapped
    from public.rounds r
   where r.id = p_round_id
     -- Issue #414: the dry run below writes (then rolls back) the same Cast
     -- Log rows Layer finalization writes. finalize_layer / resolve_round
     -- hold the round row lock FOR UPDATE before their writes; taking it FOR
     -- SHARE here, before ours, orders the two instead of letting them
     -- deadlock on those rows, and means the status read above is still
     -- true when the dry run starts. Concurrent Recap reads don't block each
     -- other.
     for share;

  if v_status is null then
    raise exception 'get_round_recap: round not found';
  end if;

  -- Issue #409: any member of the round's room may read it -- a spectator
  -- follows the round too (spec #402 story 25). Nothing here is hidden
  -- information: casts are already visible to the room.
  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) and not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = v_player_id
  ) then
    raise exception 'get_round_recap: caller is not in this round''s room';
  end if;

  -- Issue #409: the Provisional Recap (ADR 0007). While the round is live at
  -- layer 0 with nothing stored yet, and layer 0 is complete -- every roll
  -- in, no unrolled Pending Spell Die, no deferred forced-reroll target hold
  -- (the same holds as _layer_is_complete) -- dry-run the
  -- resolver with _rr_resolve, which leaves no writes, and return its Trace
  -- and summary marked provisional. A resolved round, or a layer-0 outcome
  -- already stored (a tie that moved on to tie-break layers), returns the
  -- stored Trace and summary as final.
  if v_status = 'closed' and v_layer = 0 and v_summary is null
     and (select count(*) from public.rolls where round_id = p_round_id and layer = 0)
         >= public.count_expected_layer_rollers(p_round_id, 0)
     and not exists (
       select 1 from public.spell_casts
        where round_id = p_round_id and effect_kind = 'dice_modifier'
          and not coalesce(cast_inputs ? 'dice_roll', false)
     )
     and not exists (
       select 1 from public.spell_casts
        where round_id = p_round_id
          and effect_kind = 'forced_reroll'
          and target_pending = true
          and negated = false
          and reaction_window_id is null
     ) then
    v_dry := public._rr_resolve(p_round_id);
    v_trace := coalesce(v_dry -> 'trace', '[]'::jsonb);
    v_summary := v_dry -> 'players';
    v_provisional := true;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'cast_id', c.id,
             'seq', c.seq,
             'card_name', sc.name,
             'caster_player_id', c.caster_id,
             'target_player_id', c.target_player_id,
             'target_pending', c.target_pending,
             'effect_kind', c.effect_kind,
             -- A cast attached to a reaction window is a reaction; everything
             -- else was armed during the pre-roll (declare-in) window.
             'phase', case when c.reaction_window_id is not null then 'reaction' else 'preroll' end,
             'negated', coalesce(c.negated, false),
             'redirected_to_cast_id', c.redirected_to_cast_id,
             -- Issue #440: a compelled cast or a Forfeit points back at the
             -- Brewmageddon cast that compelled it.
             'compelled_by_cast_id', c.cast_inputs ->> 'compelled_by',
             -- Coarse live state for the cast strip. Once the round leaves
             -- 'open' every armed pre-roll cast is committed (on the stack);
             -- a reaction cast is on the stack the moment it exists. The
             -- renderer overrides this with the resolved outcome once a Trace
             -- is present.
             'on_stack', (c.reaction_window_id is not null) or (v_status <> 'open')
           )
           order by c.seq
         ), '[]'::jsonb)
    into v_casts
    from public.spell_casts c
    join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
    join public.spell_cards sc on sc.id = sdi.card_id
   where c.round_id = p_round_id;

  -- Issue #406: the round's revealed rolls, every layer, flat (the client
  -- groups them) -- only layers whose rolls are all in, the same withholding
  -- rule get_round_layer_history applies, so a layer never leaks mid-roll.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'player_id', r.player_id, 'layer', r.layer, 'value', r.value,
             'modifier_snapshot', r.modifier_snapshot,
             'discarded_value', r.discarded_value,
             'entered_by_admin', r.entered_by_admin)
           order by r.layer, r.player_id
         ), '[]'::jsonb)
    into v_layers
    from public.rolls r
   where r.round_id = p_round_id
     and (
       select count(*) from public.rolls r2
        where r2.round_id = p_round_id and r2.layer = r.layer
     ) >= public.count_expected_layer_rollers(p_round_id, r.layer);

  -- Issue #406: who took part in each tie-break layer. A player tied at layer
  -- N exactly when they are in layer N+1's set -- the Reroll Chain reads tie
  -- membership from here instead of re-judging the tie.
  select coalesce(jsonb_agg(
           jsonb_build_object('layer', rlp.layer, 'player_id', rlp.player_id)
           order by rlp.layer, rlp.player_id
         ), '[]'::jsonb)
    into v_layer_participants
    from public.round_layer_participants rlp
   where rlp.round_id = p_round_id;

  -- Issue #411: who the reaction window stopped waiting on, and why (skipped
  -- by vote, or timed out) -- auto-passes recorded on the round's latest
  -- Layer 0 window.
  select coalesce(jsonb_agg(
           jsonb_build_object('player_id', p.player_id, 'reason', p.reason)
           order by p.player_id
         ), '[]'::jsonb)
    into v_reaction_skips
    from public.spell_reaction_passes p
   where p.reason <> 'pass'
     and p.window_id = (
       select w.id from public.spell_reaction_windows w
        where w.round_id = p_round_id and w.layer = 0
        order by w.opened_at desc
        limit 1
     );

  return jsonb_build_object(
    'resolved', v_status = 'resolved',
    -- "tie" once the round has any reroll-layer roll: layer 0 tied and the
    -- brewer was settled by tie-break rolls, where no spells or reactions
    -- apply (issue #219) -- the Recap ends at the tie. null while still live.
    'layer_zero_outcome', case
      when v_status <> 'resolved' then null
      when exists (
        select 1 from public.rolls
         where round_id = p_round_id and layer > 0
      ) then 'tie'
      else 'brewer'
    end,
    'trace', v_trace,
    -- Issue #407: the layer-0 Resolution Summary resolve_round stored beside
    -- the Trace. null for a round resolved before it existed (the row renders
    -- degraded) or not yet resolved. Issue #409: while provisional, the trace
    -- and players are the dry run's -- "so far, reactions pending".
    'players', v_summary,
    'provisional', v_provisional,
    'casts', v_casts,
    -- Issue #352: the retained Recap payload of every scrapped replay
    -- generation, oldest first (generation 0 is the original attempt). [] for
    -- a round that was never replayed. The client renders each as a collapsed
    -- generation-0 Round Recap disclosure under generation 1's headline.
    'scrapped_generations', v_scrapped,
    'layers', v_layers,
    'layer_participants', v_layer_participants,
    'reaction_skips', v_reaction_skips
  );
end;
$$;

revoke execute on function public.get_round_recap(uuid) from public, anon;
grant execute on function public.get_round_recap(uuid) to authenticated;

comment on function public.get_round_recap(uuid) is
  'Issue #314 (Round Recap / the Ledger) + #352: room-member-gated read '
  'returning { resolved, layer_zero_outcome, trace, casts:[{ cast_id, seq, '
  'card_name, caster_player_id, target_player_id, target_pending, effect_kind, '
  'phase, negated, redirected_to_cast_id, compelled_by_cast_id, on_stack }], scrapped_generations } '
  'for one round. trace is the persisted rounds.resolution_trace ([] until '
  'resolved); layer_zero_outcome is ''tie'' when tie-break layers decided the '
  'round; casts carries phase and coarse live state for the cast strip, with '
  'resolved per-cast state derived client-side from the Trace; '
  'scrapped_generations is rounds.scrapped_generations verbatim ([] when the '
  'round was never replayed), each entry a generation-0 Recap payload. '
  'Issue #407: players is rounds.resolution_summary (null before resolution '
  'or for a pre-summary round). Issue #409: for a live layer-0 round whose '
  'rolls are complete, trace and players come from the non-persisting '
  '_rr_resolve dry run and provisional is true (the Provisional Recap); '
  'otherwise provisional is false. Readable by any member of the round''s room. '
  'Issue #406: layers is every fully-rolled layer''s rolls (flat, the same '
  'withholding rule as get_round_layer_history) and layer_participants is '
  'round_layer_participants -- tie membership for the Reroll Chain. '
  'Issue #411: reaction_skips is [{ player_id, reason }] for everyone the '
  'latest Layer 0 reaction window stopped waiting on (reason ''vote'' or '
  '''timeout''), [] when nobody was skipped.';
-- END db/sql/functions/get_round_recap.sql

-- BEGIN db/sql/functions/is_expected_layer_roller.sql
-- is_expected_layer_roller
--
-- Rolling is held during the Compelled Cast step: nobody is an expected
-- Layer-0 roller until every compelled Action cast is in. This is the gate
-- submit_roll, submit_manual_roll and the Test Room roll-as RPCs all check,
-- and page.tsx reads it for "your turn to roll". Otherwise unchanged (0014).
create or replace function public.is_expected_layer_roller(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 and public._compelled_cast_step_open(p_round_id) then
    return false;
  end if;

  return exists (
    select 1 from public.get_expected_layer_roller_ids(p_round_id, p_layer) ids
     where ids.player_id = p_player_id
  );
end;
$$;
-- END db/sql/functions/is_expected_layer_roller.sql

-- BEGIN db/sql/functions/pass_reaction_window.sql
-- pass_reaction_window
--
-- A compelled Reaction holder cannot pass the Layer-0 window: they must cast
-- (or be skipped, which forfeits). Released holders (Brewmageddon countered)
-- pass as normal. Otherwise unchanged (0064).
create or replace function public.pass_reaction_window(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_poll_round integer;
  v_eligible_count integer;
  v_passed_count integer;
  v_closed boolean := false;
begin
  v_player_id := public.current_player_id();

  select id, poll_round into v_window_id, v_poll_round
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'pass_reaction_window: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.player_id = v_player_id and o.casting_time = 'R'
  ) then
    raise exception 'pass_reaction_window: Brewmageddon compels you to play your card'
      using errcode = 'RFB55';
  end if;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id)
  values (v_window_id, v_poll_round, v_player_id)
  on conflict (window_id, poll_round, player_id) do nothing;

  v_eligible_count := public.count_eligible_reaction_holders(p_round_id);

  select count(*) into v_passed_count
    from public.spell_reaction_passes p
    join public.spell_deck_instances sdi on sdi.held_by_player = p.player_id
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.round_participants rp on rp.player_id = sdi.held_by_player
   where p.window_id = v_window_id and p.poll_round = v_poll_round
     and sdi.location = 'held' and sc.casting_time = 'R' and rp.round_id = p_round_id;

  if v_passed_count >= v_eligible_count then
    perform public.close_reaction_window(v_window_id);
    v_closed := true;
  end if;

  return v_closed;
end;
$$;
-- END db/sql/functions/pass_reaction_window.sql

