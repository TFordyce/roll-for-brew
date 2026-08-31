-- Ward phase: polarity x domain immunity filter (issue #309, sixth
-- implementation slice of the effect-application rebuild #302 / ADR 0005 §7).
--
-- Migration number: master's highest is 0077 (0077_cast_log_schema_expand);
-- the rebuild branch adds 0078 (resolve_round authoritative, #305), 0079
-- (eager shim, #306), 0080 (cast-log resolution phase, #307), 0081
-- (counterspell backfire + Saving Steep, #308). This is 0082. Re-check at the
-- integrate step (branching strategy in #303) and renumber to sit after
-- master's current highest.
--
-- What changes
-- ------------
-- A ward is a spell_active_effects row with effect_kind = 'ward' and
-- effect_params carrying:
--   * polarity : subset of ["positive", "negative"]
--   * domain   : subset of ["modifier", "roll"]
--   * block_earned_modifier (bool, opt) -- also zeroes the brewer's tea gain
--   * block_copy (bool, opt) -- read by copy/snapshot effects (Group B, later)
-- An incoming effect is warded off when its DOMAIN matches a ward's domain and
-- its computed POLARITY (spec §7 table) is in the ward's polarity set AND the
-- ward's own cast is earlier-seq than the incoming effect (spec §7: "A ward
-- only gates casts that resolve after it (by seq)"). A ward projected from a
-- prior round (source cast in an earlier round, or no source cast) always
-- counts as earlier.
--
-- 1. spell_active_effects.rounds_remaining is relaxed to allow NULL =
--    unbounded (until dispelled / end of day). 0045 already widened the
--    > 0 check to >= 0; this drops NOT NULL and allows NULL alongside >= 0.
--
-- 2. Immutable / stable helpers:
--    * _rr_incoming_polarity(kind, ctx)  -> 'positive'|'negative'|'neutral'
--    * _rr_ward_blocks_row(params, domain, polarity) -> bool  (one ward row)
--    * _rr_el_polarity(el, base)         -> polarity of a normalised Phase 4a
--                                           effect element
--    * _rr_ward_hit(ward_map, target, domain, polarity, before_seq) -> the
--      matching ward object in resolve_round's v_ward_map, or NULL
--    * _rr_active_ward_gate(room, target, domain, polarity, round, before_seq)
--      -> the earliest matching, seq-eligible ward's (cast_id, card_name) --
--      the single lookup every eager-shim ward pre-check shares
--    * _rr_ward_wards_ward(earlier_params, later_params) -> bool (domain AND
--      polarity sets overlap)
--
-- 3. record_active_effect_if_persistent: a ward with a NULL card
--    duration_rounds now records an unbounded row instead of early-returning
--    (non-ward NULL-duration cards are unchanged). Before inserting a ward it
--    checks for a strictly earlier-seq ward on the same target that wards it
--    off -- if so the later ward row is never created (spec §7). KNOWN GAP:
--    if a deferred-OPPONENT ward's target is set AFTER a higher-seq ward has
--    already recorded its row, the earlier ward is (correctly) kept but the
--    stale higher-seq row is not retracted -- full retraction waits for the
--    spec §5 "ward projection lives in the resolver" end state. Flagged for
--    the integrator; no current card combination reaches it without a
--    deliberate deferred/immediate target ordering across two casters.
--
-- 4. Roll-domain ward pre-check in the eager shim -- apply_forced_reroll /
--    apply_roll_flip / apply_roll_swap, all via _rr_active_ward_gate. If the
--    affected player holds a matching, earlier-seq roll-domain ward the shim
--    does NOT mutate rolls.value; it records a `warded` marker on the
--    transform's players[] entry so resolve_round Phase 3 emits a `warded`
--    Trace step and adopts the unchanged roll. apply_roll_swap cancels the
--    whole swap when either end is warded against its direction (a half-swap
--    cannot conserve values). (Advantage / disadvantage at submit_roll is a
--    deliberate fast-follow: this slice covers reaction-window roll
--    transforms only.)
--
-- 5. resolve_round(uuid) gains Phase 2 (ward projection) and applies it:
--    * Phase 2 loads every active ward targeting a layer-0 roller into
--      v_ward_map, keyed by target player, each carrying its source cast seq.
--    * Phase 4a: a modifier-domain effect whose computed polarity matches an
--      earlier-seq ward on its effective (post-redirect) target is dropped
--      from the compose buckets and emitted as a `warded` step (outcome
--      'blocked'). Same check on a backfired counter's re-bucketed rows
--      (spec §8: "if the destination player has a matching ward it filters
--      normally").
--    * Phase 4c: a warded tied-lowest roller is excluded from the
--      lowest_gains_highest_modifier lift (others are still lifted).
--    * Phase 5: if the selected brewer holds a block_earned_modifier ward,
--      v_no_modifier_gain is forced true (the legacy 4-arg resolve_round
--      already turns that into a zero brewer gain downstream; its
--      rounds_remaining tick leaves a NULL-duration ward untouched).
--
-- 6. Jinxed Biscuit / Cast-Iron Kettle / Bag for Life / Eternal Steep get
--    their ward spell_card_effects row + duration and are flipped back out of
--    the bench (#284, migration 0074).
--
-- Determinism invariant is preserved: resolve_round still mutates only
-- rounds.resolution_trace and the negated / redirected_to_cast_id caches, and
-- the eager shim's `warded` markers are recorded once, at transform time,
-- into cast_inputs.

-- ===========================================================================
-- 1. spell_active_effects.rounds_remaining -- allow NULL = unbounded
-- ===========================================================================

alter table public.spell_active_effects alter column rounds_remaining drop not null;

alter table public.spell_active_effects drop constraint spell_active_effects_rounds_remaining_check;
alter table public.spell_active_effects add constraint spell_active_effects_rounds_remaining_check
  check (rounds_remaining is null or rounds_remaining >= 0);

-- ===========================================================================
-- 2. ward predicate helpers
-- ===========================================================================

-- Polarity of an incoming effect, per the spec §7 table. `p_ctx` carries just
-- the numbers the kind needs: {delta} for flat/dice/roll_swap, {multiplier}
-- for modifier_multiplier, {set_value, base} for set_modifier, {pre_value}
-- for roll_flip. Kinds outside ward scope return 'neutral'.
create or replace function public._rr_incoming_polarity(p_kind text, p_ctx jsonb)
returns text
language sql
immutable
as $$
  select case p_kind
    when 'flat_modifier' then
      case when (p_ctx->>'delta')::numeric > 0 then 'positive'
           when (p_ctx->>'delta')::numeric < 0 then 'negative'
           else 'neutral' end
    when 'dice_modifier' then
      case when (p_ctx->>'delta')::numeric > 0 then 'positive'
           when (p_ctx->>'delta')::numeric < 0 then 'negative'
           else 'neutral' end
    when 'roll_swap' then
      case when (p_ctx->>'delta')::numeric > 0 then 'positive'
           when (p_ctx->>'delta')::numeric < 0 then 'negative'
           else 'neutral' end
    when 'modifier_multiplier' then
      case when (p_ctx->>'multiplier')::numeric > 1 then 'positive'
           when (p_ctx->>'multiplier')::numeric < 1 then 'negative'
           else 'neutral' end
    when 'set_modifier' then
      case when (p_ctx->>'set_value')::numeric > (p_ctx->>'base')::numeric then 'positive'
           when (p_ctx->>'set_value')::numeric < (p_ctx->>'base')::numeric then 'negative'
           else 'neutral' end
    when 'advantage' then 'positive'
    when 'disadvantage' then 'negative'
    when 'forced_reroll' then 'negative'
    when 'roll_flip' then
      case when (p_ctx->>'pre_value')::numeric <= 10 then 'positive' else 'negative' end
    when 'lowest_gains_highest_modifier' then 'positive'
    else 'neutral'
  end;
$$;

revoke execute on function public._rr_incoming_polarity(text, jsonb) from public, anon;
grant execute on function public._rr_incoming_polarity(text, jsonb) to authenticated;

comment on function public._rr_incoming_polarity(text, jsonb) is
  'Issue #309: computed polarity (positive / negative / neutral) of an incoming spell effect, per spec §7. A neutral effect is never warded.';

-- Does one ward row's effect_params ward off (p_domain, p_polarity)? The
-- single predicate every ward check -- eager shim and resolver -- shares, so
-- there is exactly one spelling of "domain matches and polarity is in the
-- set". A neutral polarity never matches.
create or replace function public._rr_ward_blocks_row(
  p_effect_params jsonb, p_domain text, p_polarity text
)
returns boolean
language sql
immutable
as $$
  select coalesce(
    p_polarity is distinct from 'neutral'
    and p_effect_params -> 'domain' ? p_domain
    and p_effect_params -> 'polarity' ? p_polarity,
    false);
$$;

revoke execute on function public._rr_ward_blocks_row(jsonb, text, text) from public, anon;
grant execute on function public._rr_ward_blocks_row(jsonb, text, text) to authenticated;

comment on function public._rr_ward_blocks_row(jsonb, text, text) is
  'Issue #309: true when a single ward row''s effect_params wards off (p_domain, p_polarity). Shared by every ward check.';

-- Polarity of a normalised Phase 4a effect element (v_el: { kind, flat | mult
-- | set, ... }) against a target's round-start persistent modifier p_base.
-- Wraps _rr_incoming_polarity so the kind -> context mapping lives in one
-- place rather than being rebuilt at each resolve_round call site.
create or replace function public._rr_el_polarity(p_el jsonb, p_base numeric)
returns text
language sql
immutable
as $$
  select public._rr_incoming_polarity(p_el ->> 'kind', case p_el ->> 'kind'
    when 'flat_modifier' then jsonb_build_object('delta', p_el -> 'flat')
    when 'dice_modifier' then jsonb_build_object('delta', p_el -> 'flat')
    when 'modifier_multiplier' then jsonb_build_object('multiplier', p_el -> 'mult')
    when 'set_modifier' then jsonb_build_object('set_value', p_el -> 'set', 'base', to_jsonb(p_base))
    else '{}'::jsonb
  end);
$$;

revoke execute on function public._rr_el_polarity(jsonb, numeric) from public, anon;
grant execute on function public._rr_el_polarity(jsonb, numeric) to authenticated;

comment on function public._rr_el_polarity(jsonb, numeric) is
  'Issue #309: polarity of a normalised Phase 4a effect element vs the target''s round-start persistent modifier.';

-- Given resolve_round's v_ward_map ({ player_id: [ ward-obj, ... ] }, each
-- ward-obj carrying `ward_seq`), returns the first ward on p_target that wards
-- off (p_domain, p_polarity) AND is earlier-seq than p_before_seq, or NULL. A
-- ward with a NULL ward_seq (projected from a prior round) always counts as
-- earlier; a NULL p_before_seq (the incoming effect has no own seq -- e.g. a
-- carried-forward persistent effect) is treated as "after every ward".
create or replace function public._rr_ward_hit(
  p_ward_map jsonb, p_target text, p_domain text, p_polarity text, p_before_seq bigint
)
returns jsonb
language sql
immutable
as $$
  select w.value
    from jsonb_array_elements(coalesce(p_ward_map -> p_target, '[]'::jsonb)) w
   where public._rr_ward_blocks_row(w.value, p_domain, p_polarity)
     and (
       w.value -> 'ward_seq' is null
       or jsonb_typeof(w.value -> 'ward_seq') = 'null'
       or p_before_seq is null
       or (w.value ->> 'ward_seq')::bigint < p_before_seq
     )
   limit 1;
$$;

revoke execute on function public._rr_ward_hit(jsonb, text, text, text, bigint) from public, anon;
grant execute on function public._rr_ward_hit(jsonb, text, text, text, bigint) to authenticated;

comment on function public._rr_ward_hit(jsonb, text, text, text, bigint) is
  'Issue #309: first earlier-seq ward in resolve_round''s v_ward_map on p_target that wards off (p_domain, p_polarity), else NULL.';

-- The eager shim's shared ward lookup: the earliest matching, seq-eligible
-- roll-domain ward on p_target. `p_before_seq` is the seq of the transform
-- cast being gated (NULL when a direct-RPC test supplies no cast row, in
-- which case any matching ward gates). A ward whose source cast is in an
-- earlier round, or has no source cast, always counts as earlier.
create or replace function public._rr_active_ward_gate(
  p_room_id uuid, p_target text, p_domain text, p_polarity text,
  p_round_id uuid, p_before_seq bigint
)
returns table (ward_cast_id uuid, ward_card_name text)
language sql
stable
set search_path = public
as $$
  select sae.source_cast_id, scw.name
    from public.spell_active_effects sae
    join public.spell_cards scw on scw.id = sae.card_id
    left join public.spell_casts wc on wc.id = sae.source_cast_id
   where sae.room_id = p_room_id
     and sae.target_player_id = p_target
     and sae.effect_kind = 'ward'
     and public._rr_ward_blocks_row(sae.effect_params, p_domain, p_polarity)
     and (
       wc.id is null
       or wc.round_id <> p_round_id
       or p_before_seq is null
       or wc.seq < p_before_seq
     )
   order by sae.created_at
   limit 1;
$$;

revoke execute on function public._rr_active_ward_gate(uuid, text, text, text, uuid, bigint) from public, anon;
grant execute on function public._rr_active_ward_gate(uuid, text, text, text, uuid, bigint) to authenticated;

comment on function public._rr_active_ward_gate(uuid, text, text, text, uuid, bigint) is
  'Issue #309: the earliest matching, earlier-seq roll-domain ward on a player -- the shared eager-shim ward pre-check.';

-- An earlier-seq ward blocks a later ward when their DOMAIN sets overlap AND
-- their POLARITY sets overlap (spec §7: "an earlier-seq ward can ward off a
-- later ward"). Used at record time -- the later ward row is never created.
create or replace function public._rr_ward_wards_ward(p_earlier jsonb, p_later jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(exists (
           select 1 from jsonb_array_elements_text(p_earlier -> 'domain') d
            where p_later -> 'domain' ? d
         ), false)
     and coalesce(exists (
           select 1 from jsonb_array_elements_text(p_earlier -> 'polarity') pol
            where p_later -> 'polarity' ? pol
         ), false);
$$;

revoke execute on function public._rr_ward_wards_ward(jsonb, jsonb) from public, anon;
grant execute on function public._rr_ward_wards_ward(jsonb, jsonb) to authenticated;

comment on function public._rr_ward_wards_ward(jsonb, jsonb) is
  'Issue #309: true when an earlier ward''s domain AND polarity sets both overlap a later ward''s -- the earlier one wards the later one off.';

-- ===========================================================================
-- 3. record_active_effect_if_persistent -- ward rows (incl. unbounded);
--    strictly-earlier-seq ward blocks a later ward
-- ===========================================================================
-- The 0032 definition, with two changes, both scoped to effect_kind = 'ward':
--   * a NULL card duration_rounds records an unbounded row (rounds_remaining
--     NULL) instead of early-returning;
--   * a strictly earlier-seq ward on the same target that wards this one off
--     suppresses the insert. A ward already recorded whose source cast is in
--     an earlier round (or has no source cast) always counts as earlier.

create or replace function public.record_active_effect_if_persistent(
  p_room_id uuid, p_caster_id text, p_target_player_id text, p_card_id uuid,
  p_effect_kind text, p_effect_params jsonb, p_source_cast_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_duration integer;
  v_new_seq bigint;
  v_new_round uuid;
begin
  select duration_rounds into v_duration
    from public.spell_cards
   where id = p_card_id;

  -- Non-ward persistent effects still need a positive duration; a NULL there
  -- means "not persistent" for them (unchanged from 0032).
  if v_duration is null and p_effect_kind <> 'ward' then
    return;
  end if;

  -- Ward-blocks-ward (spec §7): a strictly earlier-seq ward on this target
  -- whose domain AND polarity sets overlap this incoming ward suppresses it.
  if p_effect_kind = 'ward' then
    select seq, round_id into v_new_seq, v_new_round
      from public.spell_casts where id = p_source_cast_id;

    if exists (
      select 1
        from public.spell_active_effects sae
        left join public.spell_casts wc on wc.id = sae.source_cast_id
       where sae.room_id = p_room_id
         and sae.target_player_id = p_target_player_id
         and sae.effect_kind = 'ward'
         and public._rr_ward_wards_ward(sae.effect_params, p_effect_params)
         and (
           wc.id is null
           or v_new_seq is null
           or wc.round_id is distinct from v_new_round
           or wc.seq < v_new_seq
         )
    ) then
      return;
    end if;
  end if;

  insert into public.spell_active_effects (
    room_id, target_player_id, caster_id, source_cast_id, card_id,
    effect_kind, effect_params, rounds_remaining
  )
  values (
    p_room_id, p_target_player_id, p_caster_id, p_source_cast_id, p_card_id,
    p_effect_kind, p_effect_params, v_duration   -- NULL for an unbounded ward
  );
end;
$$;

revoke execute on function public.record_active_effect_if_persistent(uuid, text, text, uuid, text, jsonb, uuid) from public, anon;

-- ===========================================================================
-- 4. Eager shim -- roll-domain ward pre-check (all via _rr_active_ward_gate)
-- ===========================================================================
-- apply_forced_reroll / apply_roll_flip / apply_roll_swap: byte-for-byte the
-- 0079 definitions, with a roll-domain ward pre-check. A warded player's
-- rolls.value is NOT touched; the transform's players[] entry carries
-- `warded: true`, `would_be_after`, `ward_cast_id`, `ward_card_name`, and
-- `after == before`. resolve_round Phase 3 turns that into a `warded` step.

create or replace function public.apply_forced_reroll(p_round_id uuid, p_layer integer, p_player_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_value integer;
  v_value integer;
  v_cast record;
  v_room_id uuid;
  v_before_seq bigint;
  v_ward record;
begin
  select value into v_old_value
    from public.rolls
   where round_id = p_round_id and layer = p_layer and player_id = p_player_id;

  if v_old_value is null then
    raise exception 'apply_forced_reroll: no existing roll for % at round %, layer %', p_player_id, p_round_id, p_layer;
  end if;

  select room_id into v_room_id from public.rounds where id = p_round_id;

  select min(casts.seq) into v_before_seq
    from public.spell_casts casts
    join public.spell_reaction_windows w on w.id = casts.reaction_window_id
   where w.round_id = p_round_id and w.layer = p_layer
     and casts.effect_kind = 'forced_reroll'
     and casts.negated = false
     and casts.target_player_id = p_player_id;

  -- forced_reroll is statically negative (spec §7).
  select g.ward_cast_id, g.ward_card_name into v_ward
    from public._rr_active_ward_gate(
      v_room_id, p_player_id, 'roll', 'negative', p_round_id, v_before_seq) g;

  if found then
    for v_cast in
      select casts.id
        from public.spell_casts casts
        join public.spell_reaction_windows w on w.id = casts.reaction_window_id
       where w.round_id = p_round_id and w.layer = p_layer
         and casts.effect_kind = 'forced_reroll'
         and casts.negated = false
         and casts.target_player_id = p_player_id
    loop
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
               'roll_transform', jsonb_build_object(
                 'kind', 'forced_reroll',
                 'order', 2,
                 'players', jsonb_build_array(jsonb_build_object(
                   'player_id', p_player_id,
                   'before', v_old_value,
                   'after', v_old_value,
                   'warded', true,
                   'would_be_after', v_old_value,
                   'ward_cast_id', v_ward.ward_cast_id,
                   'ward_card_name', v_ward.ward_card_name
                 ))
               ))
       where id = v_cast.id;
    end loop;

    return v_old_value;
  end if;

  v_value := floor(random() * 20 + 1)::integer;

  update public.rolls
     set value = v_value
   where round_id = p_round_id and layer = p_layer and player_id = p_player_id;

  for v_cast in
    select casts.id
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'forced_reroll'
       and casts.negated = false
       and casts.target_player_id = p_player_id
  loop
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', 'forced_reroll',
               'order', 2,
               'players', jsonb_build_array(jsonb_build_object(
                 'player_id', p_player_id,
                 'before', v_old_value,
                 'after', v_value
               ))
             ))
     where id = v_cast.id;
  end loop;

  return v_value;
end;
$$;

revoke execute on function public.apply_forced_reroll(uuid, integer, text) from public, anon;
grant execute on function public.apply_forced_reroll(uuid, integer, text) to authenticated;

create or replace function public.apply_roll_flip(p_round_id uuid, p_layer integer)
returns table (player_id text, value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_before_seq bigint;
  v_players jsonb := '[]'::jsonb;
  v_r record;
  v_pol text;
  v_ward record;
  v_new integer;
  v_cast record;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  select min(casts.seq) into v_before_seq
    from public.spell_casts casts
    join public.spell_reaction_windows w on w.id = casts.reaction_window_id
   where w.round_id = p_round_id and w.layer = p_layer
     and casts.effect_kind = 'roll_flip'
     and casts.negated = false;

  for v_r in
    select r.player_id, r.value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer
     order by r.player_id
  loop
    -- roll_flip polarity is per-player, from the actual pre-flip value:
    -- 21 - v > v  <=>  v <= 10  => a raise (positive).
    v_pol := case when v_r.value <= 10 then 'positive' else 'negative' end;

    select g.ward_cast_id, g.ward_card_name into v_ward
      from public._rr_active_ward_gate(
        v_room_id, v_r.player_id, 'roll', v_pol, p_round_id, v_before_seq) g;

    if found then
      v_players := v_players || jsonb_build_array(jsonb_build_object(
        'player_id', v_r.player_id,
        'before', v_r.value,
        'after', v_r.value,
        'warded', true,
        'would_be_after', 21 - v_r.value,
        'ward_cast_id', v_ward.ward_cast_id,
        'ward_card_name', v_ward.ward_card_name
      ));
    else
      v_new := 21 - v_r.value;
      update public.rolls as r
         set value = v_new
       where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_r.player_id;
      v_players := v_players || jsonb_build_array(jsonb_build_object(
        'player_id', v_r.player_id,
        'before', v_r.value,
        'after', v_new
      ));
    end if;
  end loop;

  for v_cast in
    select casts.id
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'roll_flip'
       and casts.negated = false
  loop
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', 'roll_flip',
               'order', 3,
               'players', v_players
             ))
     where id = v_cast.id;
  end loop;

  return query
    select r.player_id, r.value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer;
end;
$$;

revoke execute on function public.apply_roll_flip(uuid, integer) from public, anon;
grant execute on function public.apply_roll_flip(uuid, integer) to authenticated;

create or replace function public.apply_roll_swap(p_round_id uuid, p_layer integer)
returns table (player_id text, value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_before_seq bigint;
  v_high_player text;
  v_low_player text;
  v_high_value integer;
  v_low_value integer;
  v_cast record;
  v_ward record;
  v_ward_cast_id uuid;
  v_ward_card_name text;
  v_warded boolean := false;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  select r.player_id, r.value into v_high_player, v_high_value
    from public.rolls r
   where r.round_id = p_round_id and r.layer = p_layer
   order by r.value desc, r.player_id
   limit 1;

  select r.player_id, r.value into v_low_player, v_low_value
    from public.rolls r
   where r.round_id = p_round_id and r.layer = p_layer
   order by r.value asc, r.player_id
   limit 1;

  if v_high_player is null or v_low_player is null or v_high_player = v_low_player then
    return;
  end if;

  select min(casts.seq) into v_before_seq
    from public.spell_casts casts
    join public.spell_reaction_windows w on w.id = casts.reaction_window_id
   where w.round_id = p_round_id and w.layer = p_layer
     and casts.effect_kind = 'roll_swap'
     and casts.negated = false;

  -- The high roller strictly LOSES value (negative), the low roller strictly
  -- GAINS (positive) -- guaranteed since v_high_player <> v_low_player and the
  -- rows are ordered. If either holds a matching, earlier-seq roll-domain
  -- ward the swap cannot conserve values, so it is cancelled outright
  -- (spec §7: "no mutation").
  select g.ward_cast_id, g.ward_card_name into v_ward
    from public._rr_active_ward_gate(
      v_room_id, v_high_player, 'roll', 'negative', p_round_id, v_before_seq) g;
  if found then
    v_warded := true;
    v_ward_cast_id := v_ward.ward_cast_id;
    v_ward_card_name := v_ward.ward_card_name;
  else
    select g.ward_cast_id, g.ward_card_name into v_ward
      from public._rr_active_ward_gate(
        v_room_id, v_low_player, 'roll', 'positive', p_round_id, v_before_seq) g;
    if found then
      v_warded := true;
      v_ward_cast_id := v_ward.ward_cast_id;
      v_ward_card_name := v_ward.ward_card_name;
    end if;
  end if;

  if not v_warded then
    update public.rolls as r set value = v_low_value
     where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_high_player;
    update public.rolls as r set value = v_high_value
     where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_low_player;
  end if;

  for v_cast in
    select casts.id
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'roll_swap'
       and casts.negated = false
  loop
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', 'roll_swap',
               'order', 4,
               'players', case when v_warded then jsonb_build_array(
                   jsonb_build_object('player_id', v_high_player, 'before', v_high_value, 'after', v_high_value,
                     'warded', true, 'would_be_after', v_low_value,
                     'ward_cast_id', v_ward_cast_id, 'ward_card_name', v_ward_card_name),
                   jsonb_build_object('player_id', v_low_player, 'before', v_low_value, 'after', v_low_value,
                     'warded', true, 'would_be_after', v_high_value,
                     'ward_cast_id', v_ward_cast_id, 'ward_card_name', v_ward_card_name)
                 )
                 else jsonb_build_array(
                   jsonb_build_object('player_id', v_high_player, 'before', v_high_value, 'after', v_low_value),
                   jsonb_build_object('player_id', v_low_player, 'before', v_low_value, 'after', v_high_value)
                 )
               end
             ))
     where id = v_cast.id;
  end loop;

  if v_warded then
    return query
      select v_high_player, v_high_value
      union all
      select v_low_player, v_low_value;
  else
    return query
      select v_high_player, v_low_value
      union all
      select v_low_player, v_high_value;
  end if;
end;
$$;

revoke execute on function public.apply_roll_swap(uuid, integer) from public, anon;
grant execute on function public.apply_roll_swap(uuid, integer) to authenticated;

-- ===========================================================================
-- 5. resolve_round(uuid) -- Phase 2 ward projection + filters
-- ===========================================================================
-- Full redefinition of the 0081 function. Changes vs 0081:
--   * new declared state: v_ward_map, v_ward_hit, v_ward_pol, v_ward_idx,
--     v_wb_before, v_wb_after, v_lghm_seq;
--   * Phase 2 block (after Phase 1) builds v_ward_map (each ward carries its
--     source cast seq as ward_seq);
--   * Phase 3 emits a `warded` step for a roll transform entry the eager
--     shim marked `warded` (roll not adopted);
--   * Phase 4a (main gather loop + backfire re-bucket loop) drops a
--     modifier-domain effect warded by an earlier-seq ward and emits a
--     `warded` step;
--   * Phase 4c excludes a warded tied-lowest roller from the lift;
--   * Phase 5 forces v_no_modifier_gain for a block_earned_modifier ward on
--     the selected brewer.
-- Everything else is byte-for-byte 0081.

create or replace function public.resolve_round(p_round_id uuid)
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

  v_has_lghm boolean := false;
  v_lghm_cast record;
  v_high_roll_composed numeric;
  v_lowest_roll integer;

  v_override record;
  v_declared record;
begin
  select status, room_id, current_layer
    into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id
     for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
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
        'trace', '[]'::jsonb
      );
    end if;

    return jsonb_build_object(
      'outcome', 'tie', 'layer', v_layer,
      'brewer_id', null, 'brewer_source', null,
      'tied_player_ids', to_jsonb(v_tied),
      'cups_made', v_participant_count, 'no_modifier_gain', false,
      'trace', '[]'::jsonb
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
    v_effects_json := jsonb_set(v_effects_json, array[v_row.player_id], '[]'::jsonb, true);
  end loop;

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
               'ward_seq', wc.seq,
               'ward_cast_id', sae.source_cast_id,
               'ward_card_name', scw.name
             ) order by sae.created_at) as wards
        from public.spell_active_effects sae
        join public.spell_cards scw on scw.id = sae.card_id
        left join public.spell_casts wc on wc.id = sae.source_cast_id
       where sae.room_id = v_room_id
         and sae.effect_kind = 'ward'
         and sae.target_player_id = any (v_players)
       group by sae.target_player_id
    ) t;

  -- ------------------------------------------------------------------
  -- Phase 3: roll-input accounting (issue #306/#308/#309).
  -- ------------------------------------------------------------------
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_running := null;

    for v_row in
      select casts.id as cast_id,
             casts.seq as seq,
             casts.caster_id as caster_id,
             casts.effect_kind as kind,
             casts.negated as is_negated,
             sc.name as card_name,
             (rt.rt ->> 'order')::integer as ord,
             (pe.value ->> 'before')::numeric as p_before,
             (pe.value ->> 'after')::numeric as p_after,
             coalesce((pe.value -> 'warded')::text = 'true', false) as is_warded,
             (pe.value ->> 'would_be_after')::numeric as would_be_after,
             pe.value ->> 'ward_cast_id' as ward_cast_id,
             pe.value ->> 'ward_card_name' as ward_card_name
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')
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

      -- issue #308: a NEGATED roll transform is logically unwound.
      if v_row.is_negated then
        v_running := coalesce(v_running, v_row.p_before);
        continue;
      end if;

      v_before := coalesce(v_running, v_row.p_before);
      v_after := v_row.p_after;
      v_running := v_after;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_row.kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_row.card_name),
          'caster_player_id', to_jsonb(v_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'roll', 'value', v_before),
        jsonb_build_object('type', 'roll', 'value', v_after)
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
    select eff.target_player_id, eff.group_id, eff.effect_kind, eff.effect_params, eff.resolved_value, eff.cast_inputs,
           eff.cast_id, eff.active_effect_id, eff.card_name, eff.caster_player_id, eff.ord
      from (
        select casts.target_player_id,
               casts.card_instance_id as group_id,
               casts.effect_kind,
               casts.effect_params,
               casts.resolved_value,
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
               null::numeric as resolved_value,
               null::jsonb as cast_inputs,
               null::uuid as cast_id,
               sae.id as active_effect_id,
               sc.name as card_name,
               sae.caster_id as caster_player_id,
               null::bigint as ord,
               sae.created_at as ts
          from public.spell_active_effects sae
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
      v_el := v_el || jsonb_build_object('flat',
        case
          when v_row.cast_inputs ? 'dice_roll'
            then (v_row.cast_inputs->>'dice_roll')::numeric
                 * coalesce((v_row.effect_params->>'sign')::numeric, 1)
          else coalesce(v_row.resolved_value, 0)
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

    select v_composed[array_position(v_players, t.pid)]
      into v_high_roll_composed
      from (
        select v_players[i] as pid
          from generate_subscripts(v_players, 1) i
         order by v_rolls[i] desc, v_players[i]
         limit 1
      ) t;

    for v_i in 1 .. array_length(v_players, 1) loop
      if v_rolls[v_i] = v_lowest_roll then
        -- issue #309: a warded tied-lowest roller is excluded from the lift
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
      end if;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 5: brewer selection. Precedence declared > override > default.
  -- ------------------------------------------------------------------
  for v_declared in
    select sae.id, (sae.effect_params->>'number')::integer as number,
           sae.caster_id, sc.name as card_name
      from public.spell_active_effects sae
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
        select r.player_id into v_brewer_id
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0
         order by r.modifier_snapshot desc, r.player_id
         limit 1;
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
    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_composed);

    if array_length(v_tied, 1) > 1 then
      update public.rounds set resolution_trace = v_trace where id = p_round_id;
      return jsonb_build_object(
        'outcome', 'tie', 'layer', 0,
        'brewer_id', null, 'brewer_source', null,
        'tied_player_ids', to_jsonb(v_tied),
        'cups_made', v_participant_count, 'no_modifier_gain', false,
        'trace', v_trace
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

  update public.rounds set resolution_trace = v_trace where id = p_round_id;

  return jsonb_build_object(
    'outcome', 'brewer', 'layer', 0,
    'brewer_id', v_brewer_id, 'brewer_source', v_brewer_source,
    'tied_player_ids', null,
    'cups_made', v_participant_count, 'no_modifier_gain', v_no_modifier_gain,
    'trace', v_trace
  );
end;
$$;

revoke execute on function public.resolve_round(uuid) from public, anon;
grant execute on function public.resolve_round(uuid) to authenticated;

comment on function public.resolve_round(uuid) is
  'Authoritative layer-0 outcome resolver (issues #305/#306/#307/#308/#309, ADR 0005): Phase 1 derives negate / redirect / backfire; Phase 2 projects active wards (with source-cast seq); Phase 3 rebuilds every roller''s final roll from the eager shim (adopting a roll-domain ward''s `warded` marker unchanged); Phase 4 composes modifiers (dropping a modifier-domain effect warded by an earlier-seq ward as a `warded` step, excluding a warded tied-lowest roller from lowest_gains_highest_modifier); Phase 5 selects the brewer and forces no_modifier_gain for a block_earned_modifier ward on them. Emits the Resolution Trace into rounds.resolution_trace. Pure and idempotent over its inputs. Layer > 0 bypasses all spell logic (issue #219).';

-- ===========================================================================
-- 6. The four ward cards enter play (spec §7 per-card mapping)
-- ===========================================================================

update public.spell_cards set duration_rounds = 3 where name = 'Jinxed Biscuit';
update public.spell_cards set duration_rounds = 5 where name = 'Cast-Iron Kettle';
-- Bag for Life / Eternal Steep are unbounded -- duration_rounds stays NULL.

-- Replace any prior effect rows for these four (they were non-working, #284)
-- with the single ward row.
delete from public.spell_card_effects
 where card_id in (
   select id from public.spell_cards
    where name in ('Jinxed Biscuit', 'Cast-Iron Kettle', 'Bag for Life', 'Eternal Steep')
 );

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'TARGET', 'ward',
       '{"polarity": ["positive"], "domain": ["modifier", "roll"]}'::jsonb, 0
  from public.spell_cards where name = 'Jinxed Biscuit';

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'CASTER', 'ward',
       '{"polarity": ["negative"], "domain": ["modifier", "roll"]}'::jsonb, 0
  from public.spell_cards where name = 'Cast-Iron Kettle';

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'CASTER', 'ward',
       '{"polarity": ["positive", "negative"], "domain": ["modifier"], "block_copy": true}'::jsonb, 0
  from public.spell_cards where name = 'Bag for Life';

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'TARGET', 'ward',
       '{"polarity": ["positive", "negative"], "domain": ["modifier"], "block_earned_modifier": true}'::jsonb, 0
  from public.spell_cards where name = 'Eternal Steep';

-- Flip their benched deck instances (#284, migration 0074) back into the pool.
-- Guarded on location so this is a no-op if #284 has not run, and it never
-- disturbs an instance a player is currently holding.
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name in ('Jinxed Biscuit', 'Cast-Iron Kettle', 'Bag for Life', 'Eternal Steep')
   and sdi.location = 'benched';
