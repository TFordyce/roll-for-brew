-- _rr_active_ward_gate(uuid, text, text, text, uuid, bigint) -> record
--
-- The earliest matching, earlier-seq roll-domain ward on a player
-- (projection-filtered) -- the shared eager-shim ward pre-check.
-- Verbatim from migration 0084.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_active_ward_gate(
  p_room_id uuid, p_target text, p_domain text, p_polarity text,
  p_round_id uuid, p_before_seq bigint
)
returns table (ward_cast_id uuid, ward_card_name text)
language sql
stable
set search_path = public
as $$
  select sae.source_cast_id, scw.name
    from public._rr_active_effects_as_of(p_room_id, p_round_id) sae
    join public.spell_cards scw on scw.id = sae.card_id
    left join public.spell_casts wc on wc.id = sae.source_cast_id
   where sae.target_player_id = p_target
     and sae.effect_kind = 'ward'
     and public._rr_ward_blocks_row(sae.effect_params, p_domain, p_polarity)
     and (
       wc.id is null
       or wc.round_id <> p_round_id
       or p_before_seq is null
       or wc.seq < p_before_seq
     )
   order by sae.created_at
   limit 1;
$$;

revoke execute on function public._rr_active_ward_gate(uuid, text, text, text, uuid, bigint) from public, anon;
grant execute on function public._rr_active_ward_gate(uuid, text, text, text, uuid, bigint) to authenticated;

comment on function public._rr_active_ward_gate(uuid, text, text, text, uuid, bigint) is
  'Issue #309/#310: the earliest matching, earlier-seq roll-domain ward on a '
  'player (projection-filtered) -- the shared eager-shim ward pre-check.';
