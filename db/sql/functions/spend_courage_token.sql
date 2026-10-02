-- spend_courage_token(uuid) -> uuid
--
-- Issue #439 (Liquid Courage): the caller spends their oldest live, unspent
-- Courage Token in the round's open Layer-0 Reaction Window. The spend is a
-- Six Sugars-shaped Cast Log row -- CASTER / dice_modifier `{dice: 1d6}` on
-- the caller -- pointing at the gifting card instance and flagged
-- cast_inputs.courage_token_cast_id (the gift cast). It is a Pending Spell
-- Die: the caller rolls it in-app or enters it manually
-- (resolve_pending_spell_die_in_app / _manual), the Layer-completeness hold
-- keeps the layer from finalizing until it is in, and resolve_round Phase 4a
-- adds it after advantage / disadvantage picked the kept d20.
--
-- "Spent" is derived from the row (_rr_active_effects_as_of); there is no
-- counter. Like a Reaction cast, a spend bumps the poll
-- (_rr_reopen_or_close_reaction_poll), so everyone else may answer it and the
-- caller is still a Reaction Source while they hold another token or a card.
-- A spend is not a card: no CARD-target Reaction can target it, and it does
-- not discharge a Brewmageddon compulsion.
--
-- Raises RFB04 (no open window, as cast_reaction_spell_card) and RFB56 (no
-- spendable token: not at Layer 0, no Layer-0 roll, or none live and unspent).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.spend_courage_token(p_round_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_layer integer;
  v_token record;
  v_cast_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  -- The window row lock serialises spends (and casts and passes), so one
  -- token is never spent twice.
  select id, layer into v_window_id, v_layer
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'spend_courage_token: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'spend_courage_token: caller is not a participant in this round';
  end if;

  if v_layer <> 0 then
    raise exception 'spend_courage_token: a Courage Token adds to your first roll, so it can only be spent in the first reaction window'
      using errcode = 'RFB56';
  end if;

  if not exists (
    select 1 from public.rolls
     where round_id = p_round_id and player_id = v_player_id and layer = 0
  ) then
    raise exception 'spend_courage_token: you have no roll this round to add to'
      using errcode = 'RFB56';
  end if;

  select * into v_token
    from public._unspent_courage_tokens(p_round_id, v_player_id)
   limit 1;

  if v_token.effect_id is null then
    raise exception 'spend_courage_token: you have no Courage Token to spend'
      using errcode = 'RFB56';
  end if;

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id, target_pending,
    effect_kind, effect_params, cast_inputs, reaction_window_id, target_role
  )
  values (
    p_round_id, v_player_id, v_token.card_instance_id, v_player_id, false,
    'dice_modifier', jsonb_build_object('dice', v_token.dice),
    jsonb_build_object('courage_token_cast_id', v_token.source_cast_id),
    v_window_id, 'CASTER'
  )
  returning id into v_cast_id;

  perform public._rr_reopen_or_close_reaction_poll(p_round_id, v_window_id);

  return v_cast_id;
end;
$$;

revoke execute on function public.spend_courage_token(uuid) from public, anon;
grant execute on function public.spend_courage_token(uuid) to authenticated;

comment on function public.spend_courage_token(uuid) is
  'Issue #439: spends the caller''s oldest live unspent Courage Token in the '
  'open Layer-0 Reaction Window -- a CASTER dice_modifier {dice: 1d6} Pending '
  'Spell Die row flagged cast_inputs.courage_token_cast_id -- and bumps the '
  'poll. RFB04 no open window; RFB56 nothing to spend.';
