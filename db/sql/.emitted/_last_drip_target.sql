-- _last_drip_target(uuid) -> jsonb
--
-- Issue #470 (ADR 0005 amendment): who Last Drip (`tea_maker_override` mode
-- `prev_round_highest`, #426) names this round. The one read of the rule --
-- _rr_select_tea_maker resolves the card through it, and the cast-time
-- notice (get_last_drip_preview) previews it.
--
-- The room's most recent resolved round before this one gives the roll
-- list: its layer-0 rollers by highest value, then lowest modifier_snapshot,
-- then lowest player id. The first who is a Participant this round and not
-- Roll-Exempt (_rr_roll_exemptions) is named. Everyone ahead of them is
-- passed over, with why: `absent` (not a Participant) or `roll_exempt`.
-- Brewer Immunity is not checked here -- the named player is still subject
-- to the Brewer Candidate predicate at the override tier, as before.
--
-- Returns
--   { target_player_id  the named player, or null when inert
--     reason            null | 'no_previous_round' | 'no_eligible_roller'
--     passed_over       [ { player_id, reason } ] in roll-list order }
--
-- Read-only; safe under the Provisional Recap's rolled-back dry run. At cast
-- time it reads the round as it stands -- a later declare-in or Roll
-- Exemption can change the answer.
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._last_drip_target(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_started_at timestamptz;
  v_prev_round uuid;
  v_row record;
  v_passed jsonb := '[]'::jsonb;
begin
  select room_id, started_at into v_room_id, v_started_at
    from public.rounds where id = p_round_id;

  select pr.id into v_prev_round
    from public.rounds pr
   where pr.room_id = v_room_id
     and pr.status = 'resolved'
     and pr.id <> p_round_id
     and pr.started_at < v_started_at
   order by pr.started_at desc, pr.id
   limit 1;

  if v_prev_round is null then
    return jsonb_build_object(
      'target_player_id', null, 'reason', 'no_previous_round', 'passed_over', v_passed);
  end if;

  for v_row in
    select r.player_id,
           not exists (
             select 1 from public.round_participants rp
              where rp.round_id = p_round_id and rp.player_id = r.player_id
           ) as absent,
           exists (
             select 1 from public._rr_roll_exemptions(p_round_id) ex
              where ex.player_id = r.player_id
           ) as exempt
      from public.rolls r
     where r.round_id = v_prev_round and r.layer = 0
     order by r.value desc, r.modifier_snapshot asc, r.player_id asc
  loop
    if not v_row.absent and not v_row.exempt then
      return jsonb_build_object(
        'target_player_id', v_row.player_id, 'reason', null, 'passed_over', v_passed);
    end if;
    v_passed := v_passed || jsonb_build_array(jsonb_build_object(
      'player_id', v_row.player_id,
      'reason', case when v_row.absent then 'absent' else 'roll_exempt' end));
  end loop;

  return jsonb_build_object(
    'target_player_id', null, 'reason', 'no_eligible_roller', 'passed_over', v_passed);
end;
$$;

revoke execute on function public._last_drip_target(uuid) from public, anon, authenticated;

comment on function public._last_drip_target(uuid) is
  'Issue #470: who Last Drip names this round -- the previous resolved round''s highest layer-0 roller (ties: lowest modifier_snapshot, then player id) who is a Participant now and not Roll-Exempt, with everyone passed over and why. Inert reasons: no_previous_round, no_eligible_roller. Backs _rr_select_tea_maker and get_last_drip_preview. Internal.';
