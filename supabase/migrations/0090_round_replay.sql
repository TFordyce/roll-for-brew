-- Round replay mechanism -- Time for Brew (issue #315, spec #302 §11, ADR 0005).
-- Closes #288 (the forced_reroll/TABLE stand-in).
--
-- Time for Brew's card text: "At the end of this round, after the tea-maker is
-- announced, you may scrap the result. The round is replayed entirely -- new
-- rolls, new cards may be played."
--
-- Shape (spec §11):
--   1. Time for Brew is cast into the layer-0 reaction window like any Reaction
--      -- COUNTERABLE. A successful counter cancels the replay. This falls out
--      for free once the catalog row is 'round_replay' instead of
--      'forced_reroll': cast_reaction_spell_card writes a single TABLE-targeted
--      spell_casts row, the counter chain negates it by card_instance_id group,
--      and resolve_round has no phase that matches 'round_replay' so the round
--      resolves and announces exactly as it would with no cast at all.
--   2. If it survives, the round resolves + announces normally, then a
--      pending_round_replay row (one per round, modelled on pending_spell_draws)
--      drives a blocking confirm prompt to the caster.
--   3. Confirm  -> scrap + a clean generation-1 round from layer 0.
--      Decline / the existing 5-minute closed-round stall timer firing with the
--      decision pending -> auto-decline, round stands, card spent. No new clock.
--   4. start_round is room-locked while a replay decision is pending.
--
-- SCOPE (issue #315 was carved "core only" -- three riders are follow-ups):
--   * Per-holder roll-domain ward carry-over (Cast-Iron Kettle: keep the
--     generation-0 roll, "roll-frozen" Trace step)  -> follow-up.
--   * RoundReveal generation-1 headline with the generation-0 Recap in a
--     collapsed disclosure                          -> follow-up (this migration
--     snapshots generation 0's Recap payload into rounds.scrapped_generations so
--     that follow-up has the data).
--   * Tie-break-layer collapse *rendering* on scrap -> follow-up (the layer
--     rows themselves ARE collapsed here -- current_layer resets to 0 and the
--     round_layer_participants rows are cleared -- only the nested history
--     rendering is deferred).
--   * The #298 Group B draw_redirect mark restore-on-scrap is a no-op: nothing
--     writes those marks yet. Flagged with a comment in _rr_scrap_round below.
--
-- RETENTION NOTE: spec §11 keeps pass-1 rows at generation = 0. Threading a
-- generation filter through resolve_round / the layer-completeness helpers /
-- the cross-round modifier and active-effect projections is a large, risky
-- surface for "core only", so this slice instead DELETES generation-0's rolls /
-- spell_casts / spell_active_effects / brew_ratings / reaction windows on scrap
-- (the admin_delete_round shape, minus deleting the round row) after snapshotting
-- generation 0's Recap payload into rounds.scrapped_generations. resolve_round
-- and every reader stay untouched; generation 1 is genuinely "an ordinary round
-- from layer 0". Full row-level generation tagging + retention lands with the
-- gen-0 Recap disclosure follow-up. The generation columns (0077) stay in place
-- for that follow-up and for history labelling.

-- ===========================================================================
-- 1. rounds.scrapped_generations -- the retained Recap payload of every
--    scrapped generation, newest last. Read by the deferred RoundReveal
--    disclosure follow-up; written only by _rr_scrap_round.
-- ===========================================================================
alter table public.rounds
  add column if not exists scrapped_generations jsonb not null default '[]'::jsonb;

comment on column public.rounds.scrapped_generations is
  'Issue #315: append-only array of scrapped replay generations, each '
  '{ generation, brewer_id, cups_made, brewer_modifier_gain, resolved_at, '
  'resolution_trace, rolls, layer_participants }. Feeds the deferred '
  'generation-0 Round Recap disclosure; rounds.replay_generation is the live '
  'counter.';

-- ===========================================================================
-- 2. pending_round_replay -- one row per round, exactly while its caster still
--    has a scrap/keep decision to make. Modelled on pending_spell_draws (0036).
-- ===========================================================================
create table if not exists public.pending_round_replay (
  round_id uuid primary key references public.rounds (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  caster_id text not null references public.players (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.pending_round_replay enable row level security;

-- Readable by any authenticated user: the whole room needs to know a replay
-- decision is pending (start_round is locked for everyone, and non-casters see
-- a "waiting on X" banner), same visibility as rounds itself.
drop policy if exists "pending_round_replay is readable by authenticated users" on public.pending_round_replay;
create policy "pending_round_replay is readable by authenticated users"
  on public.pending_round_replay for select
  to authenticated
  using (true);

-- No insert/update/delete policies: writes only via the security-definer
-- functions below (same convention as pending_spell_draws).

grant all on public.pending_round_replay to service_role;
grant select on public.pending_round_replay to authenticated;

-- ===========================================================================
-- 3. Catalog: Time for Brew maps to 'round_replay', not the 'forced_reroll'
--    stand-in (0033). One event per round, so the TABLE target role stays but
--    cast_reaction_spell_card writes a single row for it (its effect_kind is
--    not in the fan-out set), which is what the counter chain and the
--    orchestration below both expect.
-- ===========================================================================
do $$
declare
  v_card_id uuid;
  v_replay_rows integer;
begin
  select id into v_card_id from public.spell_cards where name = 'Time for Brew';
  if v_card_id is null then
    raise exception '0090: Time for Brew not found in spell_cards -- name drift, aborting';
  end if;

  update public.spell_card_effects
     set effect_kind = 'round_replay'
   where card_id = v_card_id
     and effect_kind = 'forced_reroll';

  -- Idempotent guard: exactly one round_replay effect row for the card,
  -- whether this run remapped it or a prior run already did.
  select count(*) into v_replay_rows
    from public.spell_card_effects
   where card_id = v_card_id and effect_kind = 'round_replay';

  if v_replay_rows <> 1 then
    raise exception '0090: expected exactly 1 Time for Brew round_replay effect row, found %', v_replay_rows;
  end if;
end;
$$;

-- ===========================================================================
-- 4. _rr_scrap_round(uuid) -- the atomic rollback + generation bump.
--    Lives in its own SQL function (not resolve_round -- ADR 0005 keeps that
--    pure) invoked by the TS orchestration layer via confirm_round_replay.
--    Shape: admin_delete_round (0085) minus deleting the round row.
-- ===========================================================================
create or replace function public._rr_scrap_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_status text;
  v_gen integer;
  v_brewer_id text;
  v_cups_made integer;
  v_gain integer;
  v_resolved_at timestamptz;
  v_trace jsonb;
  v_snapshot jsonb;
  v_affected text[];
  v_pid text;
begin
  select room_id, status, replay_generation, brewer_id, cups_made,
         brewer_modifier_gain, resolved_at, resolution_trace
    into v_room_id, v_status, v_gen, v_brewer_id, v_cups_made,
         v_gain, v_resolved_at, v_trace
    from public.rounds
   where id = p_round_id
   for update;

  if v_room_id is null then
    raise exception '_rr_scrap_round: round not found';
  end if;
  if v_status <> 'resolved' then
    raise exception '_rr_scrap_round: round is not resolved (status %)', v_status;
  end if;

  -- Snapshot generation N's Recap payload before the delete pass removes it.
  v_snapshot := jsonb_build_object(
    'generation', v_gen,
    'brewer_id', v_brewer_id,
    'cups_made', v_cups_made,
    'brewer_modifier_gain', v_gain,
    'resolved_at', v_resolved_at,
    'resolution_trace', coalesce(v_trace, '[]'::jsonb),
    'rolls', coalesce((
      select jsonb_agg(jsonb_build_object(
               'player_id', r.player_id, 'layer', r.layer, 'value', r.value,
               'modifier_snapshot', r.modifier_snapshot,
               'discarded_value', r.discarded_value,
               'entered_by_admin', r.entered_by_admin)
             order by r.layer, r.player_id)
        from public.rolls r
       where r.round_id = p_round_id
    ), '[]'::jsonb),
    'layer_participants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'layer', rlp.layer, 'player_id', rlp.player_id)
             order by rlp.layer, rlp.player_id)
        from public.round_layer_participants rlp
       where rlp.round_id = p_round_id
    ), '[]'::jsonb)
  );

  -- Every player whose modifier cache generation N could have moved: the
  -- brewer's tea-making gain, plus both sides of any persistent modifier
  -- transfer / spend cast this round (spec §9). Captured BEFORE the delete.
  select coalesce(array_agg(distinct p), array[]::text[])
    into v_affected
    from (
      select v_brewer_id as p where v_brewer_id is not null
      union
      select sc.target_player_id
        from public.spell_casts sc
       where sc.round_id = p_round_id
         and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
         and sc.target_player_id is not null
      union
      select sc.caster_id
        from public.spell_casts sc
       where sc.round_id = p_round_id
         and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
    ) t
   where p is not null;

  update public.rounds
     set scrapped_generations = scrapped_generations || jsonb_build_array(v_snapshot)
   where id = p_round_id;

  -- Mark Time for Brew's own cast(s) scrapped -- the audit record, and the
  -- belt-and-braces guard alongside replay_generation that stops a second
  -- pending row ever being created for this round.
  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || '{"scrapped": true}'::jsonb
   where round_id = p_round_id and effect_kind = 'round_replay';

  -- Clean casting slate: no pass-1 casts carry into generation 1; cards spent
  -- in pass 1 stay spent (cast_spell_card / cast_reaction_spell_card already
  -- returned / discarded the instance at cast time -- deleting the log row
  -- does not restore it). Deleting a spell_casts row cascades its promoted
  -- spell_active_effects rows away (0084: source_cast_id NOT NULL, ON DELETE
  -- CASCADE), so pass-1-promoted active effects revert and effect-duration
  -- ticks un-happen: _rr_active_effects_as_of counts resolved rounds since the
  -- source cast, and un-resolving this round drops it from that count.
  --
  -- #298 Group B: a draw_redirect mark consumed inside this generation would
  -- be restored here too -- nothing writes those marks yet (Group B is
  -- unbuilt / out of scope for #302), so there is nothing to restore. When
  -- Group B lands, add its mark-restore pass at this point.
  delete from public.spell_casts
   where round_id = p_round_id and effect_kind <> 'round_replay';

  -- The kept round_replay cast still points at generation N's reaction window;
  -- drop that reference before the window rows go (spell_casts.reaction_window_id
  -- is NO ACTION, not cascade).
  update public.spell_casts
     set reaction_window_id = null
   where round_id = p_round_id and effect_kind = 'round_replay';

  delete from public.rolls where round_id = p_round_id;
  delete from public.round_layer_participants where round_id = p_round_id;
  delete from public.spell_reaction_windows where round_id = p_round_id;

  -- Discard generation-0 Brew Ratings; Orders (a separate table) carry over
  -- unchanged (spec §11).
  delete from public.brew_ratings where round_id = p_round_id;

  -- Back the round out to a freshly-closed generation-1 round awaiting layer-0
  -- rolls. closed_at = now() restarts the existing 5-minute stall clock for
  -- generation 1. brewer_modifier_gain -> 0 and the cache recompute below back
  -- out the brewer's tea-making gain (base = sum of cups_made over rounds
  -- brewed, per _rr_base_modifier).
  update public.rounds
     set status = 'closed',
         current_layer = 0,
         brewer_id = null,
         cups_made = null,
         brewer_modifier_gain = 0,
         resolved_at = null,
         resolution_trace = null,
         replay_generation = replay_generation + 1,
         closed_at = now()
   where id = p_round_id;

  foreach v_pid in array v_affected loop
    perform public._rr_recompute_modifier_cache(v_room_id, v_pid);
  end loop;
end;
$$;

revoke execute on function public._rr_scrap_round(uuid) from public, anon, authenticated;

comment on function public._rr_scrap_round(uuid) is
  'Issue #315: atomic scrap of a resolved round for replay -- snapshots the '
  'generation into rounds.scrapped_generations, deletes its rolls / spell_casts '
  '(cascading promoted active effects) / reaction windows / layer participants / '
  'Brew Ratings, backs the round out to a freshly-closed generation-1 round, '
  'bumps replay_generation, and recomputes room_players.modifier for the brewer '
  'and every persistent-modifier-transfer party. Internal -- called only by '
  'confirm_round_replay.';

-- ===========================================================================
-- 5. record_pending_round_replay(uuid) -- called by the TS orchestration
--    layer right after a round resolves + announces. Inserts the pending row
--    iff a surviving (non-negated, not-yet-scrapped) round_replay cast exists.
--    Idempotent.
-- ===========================================================================
create or replace function public.record_pending_round_replay(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_status text;
  v_gen integer;
  v_caster text;
begin
  select room_id, status, replay_generation
    into v_room_id, v_status, v_gen
    from public.rounds
   where id = p_round_id;

  if v_room_id is null or v_status <> 'resolved' then
    return false;
  end if;

  -- One replay per round is structural (the deck holds one Time for Brew), and
  -- belt-and-braces: never a second pending row once a generation has been
  -- scrapped.
  if v_gen <> 0 then
    return false;
  end if;

  select sc.caster_id
    into v_caster
    from public.spell_casts sc
   where sc.round_id = p_round_id
     and sc.effect_kind = 'round_replay'
     and coalesce(sc.negated, false) = false
     and coalesce(sc.cast_inputs ->> 'scrapped', '') = ''
   order by sc.seq
   limit 1;

  if v_caster is null then
    return false;
  end if;

  insert into public.pending_round_replay (round_id, room_id, caster_id)
  values (p_round_id, v_room_id, v_caster)
  on conflict (round_id) do nothing;

  return true;
end;
$$;

revoke execute on function public.record_pending_round_replay(uuid) from public, anon;
grant execute on function public.record_pending_round_replay(uuid) to authenticated;

comment on function public.record_pending_round_replay(uuid) is
  'Issue #315: inserts the pending_round_replay row for a just-resolved round '
  'iff it carries a surviving (non-negated, not-scrapped) round_replay cast and '
  'no generation has been scrapped yet. Idempotent. Returns whether a pending '
  'row now exists.';

-- ===========================================================================
-- 6. get_room_pending_round_replay(uuid) -- the room's live pending decision,
--    for page.tsx (which has no active round to hang the prompt off -- the
--    round is 'resolved' while the decision is pending).
-- ===========================================================================
create or replace function public.get_room_pending_round_replay(p_room_id uuid)
returns table (round_id uuid, caster_id text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select prr.round_id, prr.caster_id, prr.created_at
    from public.pending_round_replay prr
   where prr.room_id = p_room_id
   order by prr.created_at
   limit 1;
$$;

revoke execute on function public.get_room_pending_round_replay(uuid) from public, anon;
grant execute on function public.get_room_pending_round_replay(uuid) to authenticated;

-- ===========================================================================
-- 7. confirm_round_replay(uuid) / decline_round_replay(uuid) -- the caster's
--    scrap / keep decision. Both consume the pending row.
-- ===========================================================================
create or replace function public.confirm_round_replay(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_caster text;
begin
  v_caller := public.current_player_id(p_round_id);

  select caster_id into v_caster
    from public.pending_round_replay
   where round_id = p_round_id
   for update;

  if v_caster is null then
    raise exception 'confirm_round_replay: no replay decision is pending for this round'
      using errcode = 'RFB47';
  end if;
  if v_caller <> v_caster then
    raise exception 'confirm_round_replay: only the Time for Brew caster can scrap the round';
  end if;

  perform public._rr_scrap_round(p_round_id);

  delete from public.pending_round_replay where round_id = p_round_id;
end;
$$;

revoke execute on function public.confirm_round_replay(uuid) from public, anon;
grant execute on function public.confirm_round_replay(uuid) to authenticated;

comment on function public.confirm_round_replay(uuid) is
  'Issue #315: the Time for Brew caster scraps the resolved round -- runs '
  '_rr_scrap_round and clears the pending row. Raises RFB47 when nothing is '
  'pending.';

create or replace function public.decline_round_replay(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_caster text;
begin
  v_caller := public.current_player_id(p_round_id);

  select caster_id into v_caster
    from public.pending_round_replay
   where round_id = p_round_id
   for update;

  if v_caster is null then
    -- Idempotent: a double-tap, or a race with the stall auto-decline, is fine.
    return;
  end if;
  if v_caller <> v_caster then
    raise exception 'decline_round_replay: only the Time for Brew caster can keep or scrap the round';
  end if;

  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || '{"scrapped": false}'::jsonb
   where round_id = p_round_id and effect_kind = 'round_replay';

  delete from public.pending_round_replay where round_id = p_round_id;
end;
$$;

revoke execute on function public.decline_round_replay(uuid) from public, anon;
grant execute on function public.decline_round_replay(uuid) to authenticated;

comment on function public.decline_round_replay(uuid) is
  'Issue #315: the Time for Brew caster keeps the resolved round -- records '
  'cast_inputs.scrapped = false and clears the pending row. Idempotent.';

-- ===========================================================================
-- 8. auto_decline_stalled_round_replays() -- the "existing 5-minute closed-
--    round stall timer" branch (spec §11: "no new clock"). A pending decision
--    older than 5 minutes auto-declines; the round stands, the card is spent.
--    Swept from page.tsx render and from start_round, the same lazy
--    check-on-read pattern as enforce_stall_timeout (issue #21).
-- ===========================================================================
create or replace function public.auto_decline_stalled_round_replays()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select round_id
      from public.pending_round_replay
     where now() - created_at >= interval '5 minutes'
     for update skip locked
  loop
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || '{"scrapped": false}'::jsonb
     where round_id = v_row.round_id and effect_kind = 'round_replay';

    delete from public.pending_round_replay where round_id = v_row.round_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.auto_decline_stalled_round_replays() from public, anon;
grant execute on function public.auto_decline_stalled_round_replays() to authenticated;

comment on function public.auto_decline_stalled_round_replays() is
  'Issue #315: auto-declines every pending_round_replay older than 5 minutes '
  '(the existing closed-round stall window -- no new clock). Returns how many '
  'it cleared.';

-- ===========================================================================
-- 9. start_round -- room-locked while a replay decision is pending. Re-emits
--    0026's start_round(uuid), adding the lock (after sweeping stalled ones).
-- ===========================================================================
create or replace function public.start_round(p_room_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_date date;
  v_room_id uuid;
  v_round_id uuid;
begin
  if p_room_id is not null then
    v_room_id := p_room_id;
  else
    v_date := (now() at time zone 'Europe/London')::date;
    select id into v_room_id from public.rooms where date = v_date;
  end if;

  if v_room_id is null then
    raise exception 'start_round: no room for today';
  end if;

  -- A round replay decision pending for this room locks new rounds (spec §11).
  -- Clear any that have stalled past the 5-minute window first.
  perform public.auto_decline_stalled_round_replays();

  if exists (
    select 1 from public.pending_round_replay
     where room_id = v_room_id
  ) then
    raise exception 'start_round: a round replay decision is still pending for this room'
      using errcode = 'RFB47';
  end if;

  v_player_id := public.current_player_id(null, v_room_id);

  insert into public.rounds (room_id, started_by, status)
  values (v_room_id, v_player_id, 'open')
  returning id into v_round_id;

  insert into public.round_participants (round_id, player_id)
  values (v_round_id, v_player_id);

  return v_round_id;
end;
$$;

revoke execute on function public.start_round(uuid) from public, anon;
grant execute on function public.start_round(uuid) to authenticated;

comment on function public.start_round(uuid) is
  'Issue #315: same as 0026 plus a room lock -- raises RFB47 while a '
  'pending_round_replay decision is outstanding for the room (stalled ones are '
  'auto-declined first).';
