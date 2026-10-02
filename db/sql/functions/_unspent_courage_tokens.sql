-- _unspent_courage_tokens(uuid, text) -> table
--
-- Issue #439 (Liquid Courage): p_player_id's live, unspent Courage Tokens as
-- of p_round_id, oldest first. Live and unspent are both
-- _rr_active_effects_as_of's rules: the gift cast isn't negated, the token
-- isn't dispelled (Greater Detox), the recipient has taken part in fewer than
-- 3 resolved rounds since the gift round, and no non-negated spend row names
-- the gift cast. Two tokens are two rows, spent independently.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._unspent_courage_tokens(p_round_id uuid, p_player_id text)
returns table (
  effect_id uuid, source_cast_id uuid, card_instance_id uuid, caster_id text, dice text
)
language sql
stable
security definer
set search_path = public
as $$
  select sae.id, sae.source_cast_id, src.card_instance_id, sae.caster_id,
         coalesce(sae.effect_params ->> 'dice', '1d6')
    from public.rounds r
    cross join lateral public._rr_active_effects_as_of(r.room_id, r.id) sae
    join public.spell_casts src on src.id = sae.source_cast_id
   where r.id = p_round_id
     and sae.effect_kind = 'courage_token'
     and sae.target_player_id = p_player_id
   order by sae.created_at, sae.id;
$$;

revoke execute on function public._unspent_courage_tokens(uuid, text) from public, anon, authenticated;
grant execute on function public._unspent_courage_tokens(uuid, text) to service_role;
