-- Issue #425 (spec #401 F1): the tea-making modifier gain becomes a number.
--
-- 1. resolve_round(uuid, text, integer, integer) -- the resolution write now
--    takes a modifier gain number instead of a yes/no:
--      null  -> the normal gain, cups_made
--      0     -> no gain (Drip Tray, an Eternal Steep ward)
--      other -> used as given (e.g. 2 * cups_made for Loaf of Lipton)
--    It writes rounds.brewer_modifier_gain and adds the same amount to the
--    live room_players.modifier. _rr_base_modifier sums brewer_modifier_gain
--    (#395, 0106), so a 0 or doubled gain survives every recompute.
--    No default on p_modifier_gain, so a 3-arg call still resolves to the
--    boolean overload below and never becomes ambiguous.
--
-- 2. resolve_round(uuid, text, integer, boolean) -- the old yes/no, kept only
--    as a compat alias (admin_backfill_round's 3-arg call, older tests). It
--    delegates: true -> 0, false -> null.
--
-- 3. The tea_maker_override mode is a closed set, enforced on both the
--    catalog (spell_card_effects) and the Cast Log (spell_casts):
--      highest_modifier | highest_roll | chosen | prev_round_highest | conditional_chosen
--    A missing mode is rejected too. prev_round_highest (Last Drip) and
--    conditional_chosen (PG Tipped) are reserved for their card slices; the
--    resolver raises on them until then.

create or replace function public.resolve_round(
  p_round_id uuid, p_brewer_id text, p_cups_made integer, p_modifier_gain integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_expected_layer_count integer;
  v_roll_count integer;
  v_gain integer;
begin
  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = p_brewer_id
  ) then
    raise exception 'resolve_round: brewer is not a participant in this round';
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

  if p_cups_made <> v_participant_count then
    raise exception 'resolve_round: cups_made must equal the round''s participant count';
  end if;

  v_gain := coalesce(p_modifier_gain, p_cups_made);

  update public.rounds
     set status = 'resolved',
         brewer_id = p_brewer_id,
         cups_made = p_cups_made,
         brewer_modifier_gain = v_gain,
         resolved_at = now()
   where id = p_round_id;

  if v_gain <> 0 then
    update public.room_players
       set modifier = modifier + v_gain
     where room_id = v_room_id and player_id = p_brewer_id;
  end if;
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer, integer) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer, integer) to authenticated;

comment on function public.resolve_round(uuid, text, integer, integer) is
  'Issue #425: the resolution write. Marks the closed round resolved with '
  'p_brewer_id and p_cups_made, and applies the tea-making modifier gain: '
  'p_modifier_gain null -> cups_made, 0 -> none, any other value as given. '
  'Writes rounds.brewer_modifier_gain and adds the same amount to '
  'room_players.modifier. Committed by finalize_layer from resolve_round(uuid)''s '
  'modifier_gain.';

create or replace function public.resolve_round(
  p_round_id uuid, p_brewer_id text, p_cups_made integer, p_no_modifier_gain boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.resolve_round(
    p_round_id, p_brewer_id, p_cups_made,
    case when p_no_modifier_gain then 0 else null end::integer);
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer, boolean) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer, boolean) to authenticated;

comment on function public.resolve_round(uuid, text, integer, boolean) is
  'Compat alias (issue #425) for resolve_round(uuid, text, integer, integer): '
  'p_no_modifier_gain true -> modifier gain 0, false -> null (cups_made).';

alter table public.spell_card_effects
  add constraint spell_card_effects_tea_maker_override_mode_check
  check (
    effect_kind <> 'tea_maker_override'
    or coalesce(effect_params ->> 'mode', '') in (
      'highest_modifier', 'highest_roll', 'chosen', 'prev_round_highest', 'conditional_chosen')
  );

alter table public.spell_casts
  add constraint spell_casts_tea_maker_override_mode_check
  check (
    effect_kind is distinct from 'tea_maker_override'
    or coalesce(effect_params ->> 'mode', '') in (
      'highest_modifier', 'highest_roll', 'chosen', 'prev_round_highest', 'conditional_chosen')
  );
