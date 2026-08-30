-- Rate a spell card you've cast (issue #300): a player privately rates a
-- catalog spell card they have actually cast 1-5 stars, from the card
-- inspector in their own Spell Collection. One rating per player per card.
--
-- Patterned on brew_ratings (0058): security-definer write RPCs only (no
-- insert/update/delete RLS policies), rater-only SELECT visibility, actor
-- always resolved server-side via current_player_id(), custom RFBxx
-- errcodes documented via comment on function.
--
-- Unlike brew_ratings there is no in-app aggregate at all -- no averages,
-- counts, badges, or other-player views. "Which spells are liked/disliked"
-- is analysed straight off this table off-app. So there is no stats view
-- counterpart to this migration.
--
-- The rating targets spell_cards.id (the catalog card), not a specific
-- cast or deck instance -- edition is inherent since spell_cards.name is
-- unique. Rating rows deliberately do NOT cascade off the cast/round
-- chain: a rating survives an admin round deletion that removes the
-- qualifying cast (the collection modal then renders the stars read-only).
create table if not exists public.spell_card_ratings (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.spell_cards (id) on delete cascade,
  rater_player_id text not null references public.players (id) on delete cascade,
  score integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spell_card_ratings_score_range check (score between 1 and 5),
  constraint spell_card_ratings_card_rater_unique unique (card_id, rater_player_id)
);

-- Powers the RLS policy's / rate_spell_card's existing-row lookup by rater,
-- and the off-app "group by card" analysis scans.
create index if not exists spell_card_ratings_rater_player_id_idx
  on public.spell_card_ratings (rater_player_id);
create index if not exists spell_card_ratings_card_id_idx
  on public.spell_card_ratings (card_id);

alter table public.spell_card_ratings enable row level security;

-- Scoped to the rater alone -- covers "show me my own rating back as
-- already-submitted". No policy grants any other player row access; the
-- get_player_spell_collection RPC (security definer, below) is the only
-- path that ever surfaces my_rating, and only the viewer's own collection
-- view renders it.
create policy "spell card ratings are readable by their own rater"
  on public.spell_card_ratings for select
  to authenticated
  using (rater_player_id = public.current_player_id());

-- No insert/update/delete policies -- the only writers are the security
-- definer functions below, which bypass RLS as table owner.

-- Every table created since 0017 needs its own explicit grant (0042/issue
-- #137's lesson, restated in 0052) -- without it, PostgREST returns
-- "permission denied" before RLS even gets a say.
grant all on public.spell_card_ratings to service_role;
grant select on public.spell_card_ratings to authenticated;

-- True when p_player_id has at least one cast of p_card_id that makes the
-- card rateable: a non-negated spell_casts row whose round has resolved,
-- in a non-test room. Chains spell_casts -> spell_deck_instances ->
-- spell_cards for the card identity. Shared by rate_spell_card's guard and
-- get_player_spell_collection's is_cast_eligible column so the rule has one
-- definition.
--
-- Internal only: both callers are themselves security definer and invoke it
-- as the function owner, so it needs no execute grant to authenticated.
-- Deliberately NOT exposed as a PostgREST endpoint -- an authenticated
-- caller could otherwise probe "did player X cast card Y?" for any pair.
create or replace function public.player_has_eligible_spell_cast(
  p_player_id text,
  p_card_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.rounds r on r.id = casts.round_id
      join public.rooms room on room.id = r.room_id
     where casts.caster_id = p_player_id
       and casts.negated = false
       and sdi.card_id = p_card_id
       and r.status = 'resolved'
       and not room.is_test
  );
$$;

revoke execute on function public.player_has_eligible_spell_cast(text, uuid) from public, anon;

comment on function public.player_has_eligible_spell_cast(text, uuid) is
  'Internal eligibility predicate for spell-card rating: true when the player has a non-negated cast of the card in a resolved round of a non-test room. Called only by rate_spell_card and get_player_spell_collection; not granted to authenticated.';

-- Submits or edits (upsert-on-conflict) the caller's own rating of a spell
-- card. Enforces, in order: score in 1-5; the card exists; the caller has
-- an eligible cast of it (player_has_eligible_spell_cast). One row per
-- (card, rater) -- a second call for the same card overwrites the score.
create or replace function public.rate_spell_card(
  p_card_id uuid,
  p_score integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rater_id text;
  v_rating_id uuid;
begin
  v_rater_id := public.current_player_id();

  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'rate_spell_card: score must be between 1 and 5'
      using errcode = 'RFB41';
  end if;

  if not exists (select 1 from public.spell_cards where id = p_card_id) then
    raise exception 'rate_spell_card: card not found'
      using errcode = 'RFB42';
  end if;

  if not public.player_has_eligible_spell_cast(v_rater_id, p_card_id) then
    raise exception 'rate_spell_card: caller has no eligible cast of this card'
      using errcode = 'RFB43';
  end if;

  insert into public.spell_card_ratings (card_id, rater_player_id, score)
  values (p_card_id, v_rater_id, p_score)
  on conflict (card_id, rater_player_id)
  do update set score = excluded.score, updated_at = now()
  returning id into v_rating_id;

  return v_rating_id;
end;
$$;

revoke execute on function public.rate_spell_card(uuid, integer) from public, anon;
grant execute on function public.rate_spell_card(uuid, integer) to authenticated;

comment on function public.rate_spell_card(uuid, integer) is
  'Raises RFB41 for a score outside 1-5, RFB42 when the card does not exist, RFB43 when the caller has no non-negated cast of the card in a resolved round of a non-test room.';

-- Withdraws (hard-deletes, consistent with withdraw_brew_rating) the
-- caller's own rating for a card. A no-op if none exists: the delete
-- matches zero rows and the function returns successfully. Deliberately
-- has no eligibility re-check -- a player who loses cast-eligibility (admin
-- round deletion) can still remove a rating they hold.
create or replace function public.withdraw_spell_card_rating(p_card_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rater_id text;
begin
  v_rater_id := public.current_player_id();

  delete from public.spell_card_ratings
   where card_id = p_card_id and rater_player_id = v_rater_id;
end;
$$;

revoke execute on function public.withdraw_spell_card_rating(uuid) from public, anon;
grant execute on function public.withdraw_spell_card_rating(uuid) to authenticated;

comment on function public.withdraw_spell_card_rating(uuid) is
  'Hard-deletes the caller''s own rating for a spell card (no-op if none exists). No eligibility re-check -- a rating can always be withdrawn by its owner.';

-- Extends get_player_spell_collection (0039) with two per-card columns the
-- Spell Collection page preloads: my_rating (the caller's own 1-5 score for
-- the card, or null) and is_cast_eligible (whether the caller has a
-- rateable cast of it). Adding columns to a "returns table" signature is a
-- return-type change, so the old function has to be dropped first (same as
-- 0050's rebuild of get_round_modifier_effects).
--
-- Both new columns are scoped to the caller (current_player_id()), not to
-- p_player_id: this function is security definer and serves any viewer for
-- any target, so returning the *target* player's score / cast history would
-- ship one player's private ratings (and a "did X cast Y?" signal) in every
-- other viewer's payload, defeating spell_card_ratings' rater-only RLS. On
-- someone else's collection both columns are simply null / false -- the
-- rating row never renders there anyway.
drop function if exists public.get_player_spell_collection(text);

create function public.get_player_spell_collection(p_player_id text)
returns table (
  card_id uuid,
  name text,
  casting_time text,
  target text,
  tier text,
  effect_text text,
  draw_count integer,
  my_rating integer,
  is_cast_eligible boolean
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
    coalesce(d.draw_count, 0)::integer,
    scr.score,
    p_player_id = public.current_player_id()
      and public.player_has_eligible_spell_cast(p_player_id, sc.id)
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
  -- Joined on the caller, never p_player_id: my_rating is the *viewer's*
  -- rating, and is non-null only when they're looking at their own
  -- collection (nobody rates a card in someone else's).
  left join public.spell_card_ratings scr
    on scr.card_id = sc.id and scr.rater_player_id = public.current_player_id()
  order by sc.tier, sc.name;
$$;

revoke execute on function public.get_player_spell_collection(text) from public, anon;
grant execute on function public.get_player_spell_collection(text) to authenticated;
