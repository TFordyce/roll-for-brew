-- Fixes issue #286: Yorkshire Terror (Common, OPPONENT, Action) — "Choose a
-- target. After they roll, they must reroll and keep the new result." — has
-- no spell_card_effects row (from the T1 spell audit, #279). cast_spell_card
-- discards the held instance before its per-effect loop (0069:136-138), the
-- loop then runs zero times, and the card is silently burned with no
-- spell_casts row and no error.
--
-- Mechanically it is Milk First? (forced_reroll / TARGET) cast at Action
-- time instead of Reaction time, so one data row is most of the fix:
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params)
values (
  (select id from public.spell_cards where name = 'Yorkshire Terror'),
  'TARGET', 'forced_reroll', '{}'::jsonb
);

-- ADR 0005 note: effect application is being rebuilt (#302), not incrementally
-- extended. This change is a deliberate exception Tom greenlit on #286 as
-- "architecture-independent and safe to land ahead of the rebuild" — it adds
-- no new effect_kind and no new reader shape, it re-uses the existing
-- forced_reroll path and repairs a regression in it. When the rebuild lands,
-- Yorkshire Terror's row rides the same re-path surface as every other card.

-- The pre-roll -> apply path a TARGET/TABLE forced_reroll cast rides is
-- currently broken. 0033's open_reaction_window attached every still-
-- unattached, non-pending, non-negated layer-0 forced_reroll cast to the
-- window it opened (get_forced_reroll_targets only ever looks at window-
-- scoped rows via `join spell_reaction_windows w on w.id =
-- casts.reaction_window_id`). 0064 rewrote open_reaction_window to share
-- count_eligible_reaction_holders / close_reaction_window and, in doing so,
-- silently dropped that attach block — which also broke Tea-M Reroll / Time
-- for Brew / Wild Brew Surge branch 4 (all fan out to per-player
-- forced_reroll rows in close_round, then rely on this attach).
--
-- Restore it, this time as its own helper (the same move 0064 made for its
-- two extractions) so open_reaction_window and set_spell_cast_target below
-- can't drift.
create or replace function public.attach_pre_roll_forced_reroll_casts(
  p_round_id uuid, p_window_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.spell_casts
     set reaction_window_id = p_window_id
   where round_id = p_round_id
     and effect_kind = 'forced_reroll'
     and reaction_window_id is null
     and target_pending = false
     and negated = false;
$$;

revoke execute on function public.attach_pre_roll_forced_reroll_casts(uuid, uuid) from public, anon;
grant execute on function public.attach_pre_roll_forced_reroll_casts(uuid, uuid) to authenticated;

-- Redefines open_reaction_window (last defined 0064) to attach pre-roll-armed
-- forced_reroll casts to the layer-0 window it opens, restoring 0033's
-- behaviour. Scoped to layer 0 because a table-wide / pre-roll cast only ever
-- concerns the round's first layer; a tie-break layer's window has nothing of
-- this shape to pick up. Reaction casts already carry their own
-- reaction_window_id and are excluded by the helper's null check.
create or replace function public.open_reaction_window(p_round_id uuid, p_layer integer)
returns table (window_id uuid, is_closed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_id uuid;
  v_eligible_count integer;
begin
  if not exists (select 1 from public.rounds where id = p_round_id) then
    raise exception 'open_reaction_window: round not found';
  end if;

  insert into public.spell_reaction_windows (round_id, layer)
  values (p_round_id, p_layer)
  returning id into v_window_id;

  if p_layer = 0 then
    perform public.attach_pre_roll_forced_reroll_casts(p_round_id, v_window_id);
  end if;

  v_eligible_count := public.count_eligible_reaction_holders(p_round_id);

  if v_eligible_count = 0 then
    perform public.close_reaction_window(v_window_id);
  end if;

  window_id := v_window_id;
  is_closed := v_eligible_count = 0;
  return next;
end;
$$;

revoke execute on function public.open_reaction_window(uuid, integer) from public, anon;
grant execute on function public.open_reaction_window(uuid, integer) to authenticated;
grant execute on function public.open_reaction_window(uuid, integer) to service_role;

-- Redefines set_spell_cast_target (last defined 0032) to run the same attach
-- once it fills in a deferred target. A Yorkshire Terror cast whose target
-- wasn't a participant yet at cast time defers (target_pending = true, 0069);
-- set_spell_cast_target sets the target after close_round. If that lands
-- *after* open_reaction_window opened the layer-0 window, the attach pass
-- there already ran and skipped this still-pending row.
--
-- KNOWN GAP (deferred + no eligible reactor): with nobody holding a Reaction
-- card, open_reaction_window closes the window and the layer finalises
-- synchronously on the roll that completes it, before the caster can call
-- set_spell_cast_target at all (it then raises RFB03 — round no longer
-- 'closed'). The reroll is lost and the caster is left with an un-completable
-- cast. Fully closing this needs the resolution engine to hold layer-0
-- finalisation while a pending-target forced_reroll cast is outstanding —
-- out of scope for this data-row fix; filed as a follow-up. The common paths
-- (target declared in at cast time, or any Reaction holder present) are
-- fixed and tested here.
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
  v_window_id uuid;
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

  select id into v_window_id
    from public.spell_reaction_windows
   where round_id = v_round_id and layer = 0 and status = 'open';

  if v_window_id is not null then
    perform public.attach_pre_roll_forced_reroll_casts(v_round_id, v_window_id);
  end if;

  perform public.record_active_effect_if_persistent(
    v_room_id, v_caster_id, p_target_player_id, v_card_id,
    v_effect_kind, v_effect_params, p_cast_id
  );
end;
$$;

revoke execute on function public.set_spell_cast_target(uuid, text) from public, anon;
grant execute on function public.set_spell_cast_target(uuid, text) to authenticated;

-- Un-bench Yorkshire Terror's deck instance so draw_spell_card can pick it
-- again (#284 parks the 39 non-working cards at location = 'benched'; this
-- is one of the two with a fix issue that flips back on landing). Idempotent
-- if #284 hasn't run yet — the row is already 'in_deck'. Never touches an
-- instance a player currently holds.
update public.spell_deck_instances
   set location = 'in_deck', held_by_player = null
 where card_id = (select id from public.spell_cards where name = 'Yorkshire Terror')
   and location not in ('held', 'pending_swap');
