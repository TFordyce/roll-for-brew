-- Consolidates "who is expected to roll this round's current layer right
-- now" into one routine (issue #40). Before this, the predicate lived only
-- as is_expected_layer_roller (a single-player boolean check), and was
-- separately re-derived twice on the TS side against the same
-- round_participants/round_layer_participants excluded_at rule:
--   - page.tsx's isPlayersTurnToRoll boolean chain, which combined
--     hasDeclared/isTied membership with its own `p.excludedAt` check.
--   - stallEnforcement.ts's `expected.filter((p) => !p.excludedAt)`.
-- Neither TS copy had a shared type forcing it to agree with SQL if the rule
-- changes (e.g. how exclusion interacts with tie phase) — a change would
-- have to be found and re-applied by hand in three places.
--
-- get_expected_layer_roller_ids is the new single source of truth: the set
-- of player_ids currently expected to roll a round's given layer. Both
-- is_expected_layer_roller (the single-player gate used by
-- submit_roll/submit_manual_roll/get_current_layer_rolls_if_complete) and
-- count_expected_layer_rollers (0012's shared count) are redefined in terms
-- of it below, and it's granted to authenticated so page.tsx and
-- stallEnforcement.ts can ask SQL directly instead of re-deriving the answer
-- from raw participant rows.
create or replace function public.get_expected_layer_roller_ids(p_round_id uuid, p_layer integer)
returns table (player_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    return query
      select rp.player_id from public.round_participants rp
       where rp.round_id = p_round_id and rp.excluded_at is null;
  else
    return query
      select rlp.player_id from public.round_layer_participants rlp
       where rlp.round_id = p_round_id and rlp.layer = p_layer and rlp.excluded_at is null;
  end if;
end;
$$;

revoke execute on function public.get_expected_layer_roller_ids(uuid, integer) from public, anon;
grant execute on function public.get_expected_layer_roller_ids(uuid, integer) to authenticated;

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
  return exists (
    select 1 from public.get_expected_layer_roller_ids(p_round_id, p_layer) ids
     where ids.player_id = p_player_id
  );
end;
$$;

create or replace function public.count_expected_layer_rollers(p_round_id uuid, p_layer integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.get_expected_layer_roller_ids(p_round_id, p_layer);
  return v_count;
end;
$$;
