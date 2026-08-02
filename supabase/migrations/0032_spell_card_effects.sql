-- Normalizes spell_cards.effect_kind/effect_params (one effect per card)
-- into spell_card_effects (one-to-many): a card can now carry N simultaneous
-- effects, each with its own target role. Fixes Cold Tea (reported: cast on
-- a player, nothing appeared on their calculation) and Slipped Spoon, whose
-- "opponent penalty + caster bonus" shape a single effect_kind/effect_params
-- pair couldn't represent without silently dropping half of it
-- (research/spell-cards-effect-mapping.md's "Compound cards" gap, from
-- issue #70/#22's full-catalog mapping pass).
--
-- target_role: TARGET (whoever the card was cast at) and CASTER (the caster
-- themself) are the two roles implemented by cast_spell_card/cast_reaction_
-- spell_card below. TABLE/ALL_OTHER_PLAYERS/CHOSEN_PLAYERS/WILD are reserved
-- for #115 (TABLE/WILD casting support) — no card references them yet, and
-- cast_spell_card/cast_reaction_spell_card still reject TABLE/WILD-targeted
-- cards outright, unchanged from before this migration.
create table public.spell_card_effects (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.spell_cards (id) on delete cascade,
  target_role text not null
    check (target_role in ('TARGET', 'CASTER', 'TABLE', 'ALL_OTHER_PLAYERS', 'CHOSEN_PLAYERS', 'WILD')),
  effect_kind text not null check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'hidden_modifier', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect'
  )),
  effect_params jsonb not null default '{}'::jsonb,
  ordinal integer not null default 0
);

alter table public.spell_card_effects enable row level security;

-- Same reasoning as spell_cards (0017): effects aren't secret, only which
-- physical instance a player holds is.
create policy "spell_card_effects are readable by authenticated users"
  on public.spell_card_effects for select
  to authenticated
  using (true);

-- Migrate the 18 cards already mapped via spell_cards.effect_kind/
-- effect_params (0017/0020/0021/0022) into single-row entries here.
-- target_role mirrors how cast_spell_card/cast_reaction_spell_card already
-- resolve each card's final target: SELF -> CASTER, OPPONENT/PLAYER ->
-- TARGET, CARD -> TARGET (which those functions already resolve to null for
-- CARD-stamped cards — Tannin Tantrum/Mug Mirror/Lesser Detox/Greater Detox
-- — so this reproduces existing behaviour exactly, not a new role).
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params) values
  ((select id from public.spell_cards where name = 'Lucky Sip'), 'CASTER', 'flat_modifier', '{"delta": 3}'::jsonb),
  ((select id from public.spell_cards where name = 'Caffeinated Focus'), 'CASTER', 'flat_modifier', '{"delta": 5}'::jsonb),
  ((select id from public.spell_cards where name = 'Brewer''s Blessing'), 'TARGET', 'flat_modifier', '{"delta": 5}'::jsonb),
  ((select id from public.spell_cards where name = 'Double Shot'), 'CASTER', 'modifier_multiplier', '{"multiplier": 2}'::jsonb),
  ((select id from public.spell_cards where name = 'Milky Brew'), 'TARGET', 'set_modifier', '{"value": 0}'::jsonb),
  ((select id from public.spell_cards where name = 'Sugar Rush'), 'CASTER', 'advantage', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Fortune''s Flavour'), 'TARGET', 'advantage', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Caffeine Crash'), 'TARGET', 'set_modifier', '{"value": -1}'::jsonb),
  ((select id from public.spell_cards where name = 'Cloud of Cream'), 'CASTER', 'hidden_modifier', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Lesser Detox'), 'TARGET', 'dispel', '{"tiers": ["common"]}'::jsonb),
  ((select id from public.spell_cards where name = 'Tannin Tantrum'), 'TARGET', 'contested_negate', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Mug Mirror'), 'TARGET', 'redirect', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Double Dunk'), 'CASTER', 'forced_reroll', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Re-Steep'), 'CASTER', 'forced_reroll', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Milk First?'), 'TARGET', 'forced_reroll', '{}'::jsonb),
  ((select id from public.spell_cards where name = 'Six Sugars'), 'CASTER', 'dice_modifier', '{"dice": "1d6"}'::jsonb),
  ((select id from public.spell_cards where name = 'Mug Shot'), 'TARGET', 'set_modifier', '{"value": 0}'::jsonb),
  ((select id from public.spell_cards where name = 'Greater Detox'), 'TARGET', 'dispel', '{"tiers": ["rare", "epic"]}'::jsonb);

-- Cold Tea / Slipped Spoon: the two currently-known compound cards, an
-- opponent-facing penalty plus a caster-facing bonus, now expressible as two
-- rows instead of one effect_kind/effect_params pair silently dropping half.
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal) values
  ((select id from public.spell_cards where name = 'Cold Tea'), 'TARGET', 'flat_modifier', '{"delta": -3}'::jsonb, 0),
  ((select id from public.spell_cards where name = 'Cold Tea'), 'CASTER', 'dice_modifier', '{"dice": "1d4"}'::jsonb, 1),
  ((select id from public.spell_cards where name = 'Slipped Spoon'), 'TARGET', 'disadvantage', '{}'::jsonb, 0),
  ((select id from public.spell_cards where name = 'Slipped Spoon'), 'CASTER', 'dice_modifier', '{"dice": "1d4"}'::jsonb, 1);

-- spell_cards.effect_kind/effect_params are now fully superseded by
-- spell_card_effects; every function that read them directly is redefined
-- below to read spell_card_effects instead (or, for record_active_effect_
-- if_persistent/set_spell_cast_target, the effect_kind/effect_params already
-- copied onto the relevant spell_casts row at cast time).
alter table public.spell_cards drop constraint spell_cards_effect_kind_check;
alter table public.spell_cards drop column effect_kind;
alter table public.spell_cards drop column effect_params;

-- record_active_effect_if_persistent (0020) now takes the effect's kind/
-- params as explicit parameters instead of re-reading them off spell_cards
-- (which no longer carries a single effect_kind/effect_params pair) —
-- duration_rounds stays a per-card value, so that lookup is unchanged.
-- Signature grew two parameters, so the old one must be dropped first.
drop function if exists public.record_active_effect_if_persistent(uuid, text, text, uuid, uuid);

create function public.record_active_effect_if_persistent(
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
begin
  select duration_rounds into v_duration
    from public.spell_cards
   where id = p_card_id;

  if v_duration is null then
    return;
  end if;

  insert into public.spell_active_effects (
    room_id, target_player_id, caster_id, source_cast_id, card_id,
    effect_kind, effect_params, rounds_remaining
  )
  values (
    p_room_id, p_target_player_id, p_caster_id, p_source_cast_id, p_card_id,
    p_effect_kind, p_effect_params, v_duration
  );
end;
$$;

revoke execute on function public.record_active_effect_if_persistent(uuid, text, text, uuid, text, jsonb, uuid) from public, anon;

-- Redefines cast_spell_card (0026) to resolve every one of the held card's
-- spell_card_effects rows instead of a single effect_kind/effect_params
-- pair, inserting one spell_casts row per effect row (CASTER role always
-- resolves to the caster; TARGET role resolves to the same final target/
-- pending state the SELF/OPPONENT/PLAYER targeting block below already
-- computed once for the whole card). Every other rule — targeting, the
-- RFB03 stale-round race, dice-modifier resolution — is unchanged, just
-- moved per-row so each effect gets its own independent dice roll.
create or replace function public.cast_spell_card(p_round_id uuid, p_target_player_id text default null)
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
  v_casting_time text;
  v_target_stamp text;
  v_target_pending boolean := false;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_pending boolean;
  v_row_cast_id uuid;
  v_resolved_value numeric;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'cast_spell_card: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'cast_spell_card: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  select sdi.id, sc.id, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'cast_spell_card: only Action cards can be cast pre-roll';
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
  else
    raise exception 'cast_spell_card: % -targeted cards cannot be cast pre-roll yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id
     order by ordinal
  loop
    v_row_target := case when v_effect.target_role = 'CASTER' then v_player_id else v_final_target end;
    v_row_pending := v_effect.target_role <> 'CASTER' and v_target_pending;
    v_resolved_value := null;

    if v_effect.effect_kind = 'dice_modifier' then
      v_dice_count := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
      v_dice_sides := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
      v_dice_sign := coalesce((v_effect.effect_params ->> 'sign')::integer, 1);

      v_roll_total := 0;
      for i in 1..v_dice_count loop
        v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
      end loop;

      v_resolved_value := v_roll_total * v_dice_sign;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, resolved_value
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, v_row_pending,
      v_effect.effect_kind, v_effect.effect_params, v_resolved_value
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_row_target is not null then
      perform public.record_active_effect_if_persistent(
        v_room_id, v_player_id, v_row_target, v_card_id,
        v_effect.effect_kind, v_effect.effect_params, v_row_cast_id
      );
    end if;
  end loop;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text) from public, anon;
grant execute on function public.cast_spell_card(uuid, text) to authenticated;

-- Redefines set_spell_cast_target (0026) to source the effect_kind/
-- effect_params it passes to record_active_effect_if_persistent from the
-- cast row itself (already copied there at cast_spell_card time) rather
-- than re-deriving them — a deferred OPPONENT/PLAYER compound cast only
-- ever has one pending row (the TARGET-role one; CASTER-role resolves
-- immediately at cast time), so this still only ever fills in one row's
-- target, unchanged from before this migration.
create or replace function public.set_spell_cast_target(p_cast_id uuid, p_target_player_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_round_id uuid;
  v_room_id uuid;
  v_caster_id text;
  v_target_pending boolean;
  v_status text;
  v_target_stamp text;
  v_card_id uuid;
  v_effect_kind text;
  v_effect_params jsonb;
begin
  select round_id, caster_id, target_pending, effect_kind, effect_params
    into v_round_id, v_caster_id, v_target_pending, v_effect_kind, v_effect_params
    from public.spell_casts
   where id = p_cast_id;

  if v_round_id is null then
    raise exception 'set_spell_cast_target: cast not found';
  end if;

  v_player_id := public.current_player_id(v_round_id);

  if v_caster_id <> v_player_id then
    raise exception 'set_spell_cast_target: only the caster can set this cast''s target';
  end if;

  if not v_target_pending then
    raise exception 'set_spell_cast_target: this cast is not awaiting a target';
  end if;

  select status, room_id into v_status, v_room_id from public.rounds where id = v_round_id;

  if v_status <> 'closed' then
    raise exception 'set_spell_cast_target: round is not yet closed for targeting'
      using errcode = 'RFB03';
  end if;

  select sc.target, sc.id
    into v_target_stamp, v_card_id
    from public.spell_casts casts
    join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
    join public.spell_cards sc on sc.id = sdi.card_id
   where casts.id = p_cast_id;

  if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
    raise exception 'set_spell_cast_target: this card cannot target yourself';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = v_round_id and player_id = p_target_player_id
  ) then
    raise exception 'set_spell_cast_target: target is not a participant in this round';
  end if;

  update public.spell_casts
     set target_player_id = p_target_player_id, target_pending = false
   where id = p_cast_id;

  perform public.record_active_effect_if_persistent(
    v_room_id, v_caster_id, p_target_player_id, v_card_id,
    v_effect_kind, v_effect_params, p_cast_id
  );
end;
$$;

revoke execute on function public.set_spell_cast_target(uuid, text) from public, anon;
grant execute on function public.set_spell_cast_target(uuid, text) to authenticated;

-- Redefines cast_reaction_spell_card (0026) with the same per-row fan-out as
-- cast_spell_card above. No Reaction-timed card is compound today, so this
-- always loops exactly once in practice, but every Reaction card's effect
-- now lives in spell_card_effects too, so this must read from there
-- regardless. contested_negate/redirect's post-processing runs per matching
-- row (using that row's own inserted id), which is exactly one row for the
-- cards that use those kinds (Tannin Tantrum, Mug Mirror).
create or replace function public.cast_reaction_spell_card(
  p_round_id uuid, p_target_player_id text default null, p_target_cast_id uuid default null
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
  v_resolved_value numeric;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_target_tier text;
  v_target_target_player text;
  v_dc integer;
  v_roll integer;
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
    select casts.target_player_id, sc2.tier
      into v_target_target_player, v_target_tier
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
  else
    raise exception 'cast_reaction_spell_card: % -targeted cards cannot be cast as a reaction yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id
     order by ordinal
  loop
    v_row_target := case when v_effect.target_role = 'CASTER' then v_player_id else v_final_target end;
    v_resolved_value := null;

    if v_effect.effect_kind = 'dice_modifier' then
      v_dice_count := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
      v_dice_sides := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
      v_dice_sign := coalesce((v_effect.effect_params ->> 'sign')::integer, 1);

      v_roll_total := 0;
      for i in 1..v_dice_count loop
        v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
      end loop;

      v_resolved_value := v_roll_total * v_dice_sign;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, resolved_value, parent_cast_id, reaction_window_id
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, false,
      v_effect.effect_kind, v_effect.effect_params, v_resolved_value, p_target_cast_id, v_window_id
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_effect.effect_kind = 'contested_negate' then
      v_dc := case v_target_tier when 'common' then 2 when 'rare' then 5 else 10 end;
      v_roll := floor(random() * 20 + 1)::integer;

      update public.spell_casts set resolved_value = v_roll where id = v_row_cast_id;

      if v_roll >= v_dc then
        update public.spell_casts set negated = true where id = p_target_cast_id;
      end if;
    elsif v_effect.effect_kind = 'redirect' then
      update public.spell_casts set resolved_value = 1 where id = v_row_cast_id;

      if v_target_target_player is not null then
        update public.spell_casts set target_player_id = v_player_id where id = p_target_cast_id;
      end if;
    end if;
  end loop;

  update public.spell_reaction_windows
     set poll_round = poll_round + 1
   where id = v_window_id;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_reaction_spell_card(uuid, text, uuid) from public, anon;
grant execute on function public.cast_reaction_spell_card(uuid, text, uuid) to authenticated;

-- Redefines get_held_card_effect (0020) to derive effect_kind/effect_params
-- from spell_card_effects: a card with exactly one effect row reports that
-- row's kind/params (identical to today for every currently-mapped single-
-- effect card, including the dispel-kind cards this function's only two
-- callers — get_dispellable_active_effects/end_active_effect — actually
-- gate on); a card with zero or more-than-one row reports null, same as an
-- unmapped or compound card already does today. Returns zero rows (not a
-- null-filled row) when the player holds no card, unchanged from before.
create or replace function public.get_held_card_effect(p_player_id text)
returns table (instance_id uuid, casting_time text, effect_kind text, effect_params jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_effect_count integer;
begin
  select sdi.id as instance_id, sc.casting_time, sc.id as card_id
    into v_row
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = p_player_id and sdi.location = 'held';

  if v_row.instance_id is null then
    return;
  end if;

  select count(*) into v_effect_count
    from public.spell_card_effects
   where card_id = v_row.card_id;

  instance_id := v_row.instance_id;
  casting_time := v_row.casting_time;

  if v_effect_count = 1 then
    select sce.effect_kind, sce.effect_params
      into effect_kind, effect_params
      from public.spell_card_effects sce
     where sce.card_id = v_row.card_id;
  end if;

  return next;
end;
$$;

revoke execute on function public.get_held_card_effect(text) from public, anon;

-- Redefines get_my_spell_cards (0026) with the same "single effect row ->
-- that kind, else null" derivation as get_held_card_effect above, so the
-- casting-UI's dispel-picker gate (held.effectKind === "dispel" in
-- SpellCardPanel.tsx) keeps working unchanged for every currently-mapped
-- card without the client needing to know about spell_card_effects at all.
create or replace function public.get_my_spell_cards(p_room_id uuid default null)
returns table (
  instance_id uuid,
  location text,
  card_name text,
  casting_time text,
  target text,
  tier text,
  effect_text text,
  effect_kind text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  return query
    select sdi.id, sdi.location, sc.name, sc.casting_time, sc.target, sc.tier, sc.effect_text,
      case
        when (select count(*) from public.spell_card_effects sce where sce.card_id = sc.id) = 1
          then (select sce.effect_kind from public.spell_card_effects sce where sce.card_id = sc.id)
        else null
      end
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = v_player_id
       and sdi.location in ('held', 'pending_swap');
end;
$$;

revoke execute on function public.get_my_spell_cards(uuid) from public, anon;
grant execute on function public.get_my_spell_cards(uuid) to authenticated;
