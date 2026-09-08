-- close_round(p_round_id uuid) -> void
--
-- Lock the roster and fan out a caster's TABLE / ALL_OTHER_PLAYERS
-- placeholder casts into one real spell_casts row per participant.
-- Verbatim from migration 0083.
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
  v_placeholder record;
  v_participant record;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_card_id uuid;
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

  for v_placeholder in
    select id, caster_id, effect_kind, effect_params, card_instance_id, target_role
      from public.spell_casts
     where round_id = p_round_id
       and target_pending = true
       and target_player_id is null
       and target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
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

revoke execute on function public.close_round(uuid) from public, anon;
grant execute on function public.close_round(uuid) to authenticated;
