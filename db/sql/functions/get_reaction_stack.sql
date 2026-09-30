-- get_reaction_stack
--
-- The reaction stack also carries the round's Brewmageddon cast while a
-- window is open: it is always a legal CARD target (#385), and a compelled
-- CARD-target Reaction holder must be able to pick it even when no cast is
-- attached to the window. Otherwise unchanged (0021).
create or replace function public.get_reaction_stack(p_round_id uuid)
returns table (
  cast_id uuid, card_name text, caster_id text, caster_name text,
  target_stamp text, negated boolean, parent_cast_id uuid, seq bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select casts.id, sc.name, casts.caster_id, coalesce(p.display_name, p.email),
      sc.target, casts.negated, casts.parent_cast_id, casts.seq
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
      join public.players p on p.id = casts.caster_id
      left join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where (w.round_id = p_round_id and w.status = 'open')
        or (casts.round_id = p_round_id
            and casts.effect_kind = 'compel_cast'
            and exists (
              select 1 from public.spell_reaction_windows ow
               where ow.round_id = p_round_id and ow.status = 'open'))
     order by casts.seq asc;
end;
$$;
