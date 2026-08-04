-- get_player_spell_collection (issue #133, child of the Spell Collection
-- page build spec #130): one call returning a player's full spell
-- collection — every catalog card left-joined against that player's own
-- draw counts — for the Collection page to render directly, rather than
-- the page having to stitch together a catalog read and a per-player
-- draw-count query itself.
--
-- Deliberately plain "language sql" (unlike the plpgsql RPCs elsewhere in
-- this file set): no caller-identity resolution, no admin/Test-Room gate —
-- p_player_id is an explicit parameter, not resolved via
-- current_player_id(), so the same call path serves both "my collection"
-- and "someone else's" (any authenticated player can read any other
-- player's collection — spell card names/effects aren't secret, 0017/0032;
-- only who holds which physical instance is).
--
-- Test Player exclusion is re-implemented here rather than relied on via
-- spell_draws' RLS policy ("readable by the drawing player", 0018) —
-- security definer bypasses RLS entirely, so without an explicit
-- "not p.is_test" filter in the draw-count subquery, calling this with a
-- Test Player's id would report their Test Room draws as real discoveries.
create function public.get_player_spell_collection(p_player_id text)
returns table (
  card_id uuid,
  name text,
  casting_time text,
  target text,
  tier text,
  effect_text text,
  draw_count integer
)
language sql
security definer
set search_path = public
as $$
  select
    sc.id,
    sc.name,
    case when coalesce(d.draw_count, 0) > 0 then sc.casting_time end,
    case when coalesce(d.draw_count, 0) > 0 then sc.target end,
    sc.tier,
    case when coalesce(d.draw_count, 0) > 0 then sc.effect_text end,
    coalesce(d.draw_count, 0)::integer
  from public.spell_cards sc
  left join (
    select sdi.card_id, count(*) as draw_count
      from public.spell_draws sd
      join public.spell_deck_instances sdi on sdi.id = sd.card_instance_id
      join public.players p on p.id = sd.player_id
     where sd.player_id = p_player_id
       and not p.is_test
     group by sdi.card_id
  ) d on d.card_id = sc.id
  order by sc.tier, sc.name;
$$;

revoke execute on function public.get_player_spell_collection(text) from public, anon;
grant execute on function public.get_player_spell_collection(text) to authenticated;
