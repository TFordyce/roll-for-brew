-- _rr_pick_lowest(text[], integer[], numeric[], boolean[]) -> text[]
--
-- Lowest composed roll+modifier winner set, with the Calami-Tea nat-1
-- dice-reduced rule (4-arg form; the 3-arg form is dropped here).
-- Verbatim from migration 0100 (leading `drop function if exists` kept).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

drop function if exists public._rr_pick_lowest(text[], integer[], numeric[]);

create or replace function public._rr_pick_lowest(
  p_players text[], p_rolls integer[], p_modifier numeric[],
  p_dice_reduced boolean[] default null
)
returns text[]
language plpgsql
immutable
as $$
declare
  v_result text[];
  v_min numeric;
begin
  -- Natural-1 auto-lose. A Calami-Tea (per_round_dice_tick) roll floored to 1
  -- this round carries p_dice_reduced[i] = true and is not eligible here.
  if exists (
    select 1 from generate_subscripts(p_rolls, 1) i
     where p_rolls[i] = 1 and not coalesce(p_dice_reduced[i], false)
  ) then
    select min(p_modifier[i]) into v_min
      from generate_subscripts(p_players, 1) i
     where p_rolls[i] = 1 and not coalesce(p_dice_reduced[i], false);
    select array_agg(p_players[i] order by p_players[i]) into v_result
      from generate_subscripts(p_players, 1) i
     where p_rolls[i] = 1 and not coalesce(p_dice_reduced[i], false)
       and p_modifier[i] = v_min;
    return v_result;
  end if;

  if not exists (select 1 from unnest(p_rolls) x where x <> 20) then
    select min(p_modifier[i]) into v_min from generate_subscripts(p_players, 1) i;
    select array_agg(p_players[i] order by p_players[i]) into v_result
      from generate_subscripts(p_players, 1) i where p_modifier[i] = v_min;
    return v_result;
  end if;

  select min(p_rolls[i] + p_modifier[i]) into v_min
    from generate_subscripts(p_players, 1) i where p_rolls[i] <> 20;
  select array_agg(p_players[i] order by p_players[i]) into v_result
    from generate_subscripts(p_players, 1) i
   where p_rolls[i] <> 20 and (p_rolls[i] + p_modifier[i]) = v_min;
  return v_result;
end;
$$;
revoke execute on function public._rr_pick_lowest(text[], integer[], numeric[], boolean[]) from public, anon;
grant execute on function public._rr_pick_lowest(text[], integer[], numeric[], boolean[]) to authenticated;
