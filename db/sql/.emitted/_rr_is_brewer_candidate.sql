-- _rr_is_brewer_candidate(jsonb, text) -> boolean
--
-- Issue #451 (ADR 0005 tier 0): the one Brewer Candidate predicate of the
-- Tea-Maker Precedence Ladder. Every tier of _rr_select_tea_maker asks it
-- whether a player may be named Tea Maker -- the declared-number match, the
-- override target, the lowest-roller pool and the all-immune give-way -- so
-- Brewer Immunity has exactly one form. p_immune is the selection's immunity
-- map ({ player_id: { ae_id, caster_id, card_name, override_proof } }).
--
-- The place the later candidate rules extend: Tea Cosy (#434) and Roll
-- Exemption (#433). The Earl of Earl Grey (#429) needs nothing here -- the
-- Earl is no candidate at any tier; an override that forces tea on them is
-- a title transfer handled at _rr_select_tea_maker's override tier. `immutable`
-- holds only while it reads nothing but its arguments.
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_is_brewer_candidate(p_immune jsonb, p_player text)
returns boolean
language sql
immutable
as $$
  select not (p_immune ? p_player);
$$;

revoke execute on function public._rr_is_brewer_candidate(jsonb, text) from public, anon, authenticated;

comment on function public._rr_is_brewer_candidate(jsonb, text) is
  'Issue #451 (ADR 0005 tier 0): the Brewer Candidate predicate -- false for a player holding Brewer Immunity in the selection''s immunity map. Every tier of _rr_select_tea_maker filters through it. Internal.';
