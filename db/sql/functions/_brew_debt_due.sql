-- _brew_debt_due(p_round_id uuid) -> jsonb
--
-- Issue #432 (spec #401, design #382): the Brew Debt this round pays, or
-- null when it isn't a debt round. The one read behind "is this a debt
-- round?" -- the expected-roller set, Layer 0's completeness, advance_layer's
-- debt-round branch, finalize_layer and the pre-ladder rule in
-- _rr_select_tea_maker all ask it.
--
-- A Brew Debt is live, never stored: a round recorded ('brew_iou', cast) and
-- no round has recorded ('brew_debt', cast) yet. It is searched across all of
-- the Debtor's rooms -- the first resolver state that crosses rooms and days
-- (ADR 0005, Brew Debt note) -- but never between the Test Room and a real
-- room. The Debtor is the Brew IOU cast's caster.
--
-- The round pays a debt when ALL of:
--   * it has no layer-0 roll -- a debt round never rolls, so a round that has
--     started rolling stays a normal round (a Late Declare only converts it
--     while nobody has rolled);
--   * a Debtor is a Participant (not excluded) with a live debt from a round
--     resolved before this one closed;
--   * that Debtor has no Brewer Immunity as of this round. An immune Debtor
--     plays normally and the debt stays owed.
-- Several debts: the oldest (Brew IOU round resolved first, then cast order)
-- of a non-immune Debtor pays; the rest stay owed. A Debtor who owes twice
-- pays one per round, oldest first.
--
-- The round being asked about never counts as having paid: once a debt round
-- resolves it still reads as one.
--
-- Returns { debtor_player_id, cast_id, card_name, brew_iou_round_id } or null.
-- Read-only; safe under the Provisional Recap's rolled-back dry run.
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._brew_debt_due(p_round_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'debtor_player_id', sc.caster_id,
           'cast_id', sc.id,
           'card_name', card.name,
           'brew_iou_round_id', iou.id
         )
    from public.rounds r
    join public.rooms room on room.id = r.room_id
    join public.round_participants rp
      on rp.round_id = r.id and rp.excluded_at is null
    join public.spell_casts sc on sc.caster_id = rp.player_id
    join public.rounds iou
      on iou.brewer_source = 'brew_iou'
     and iou.brewer_source_cast_id = sc.id
    join public.rooms iou_room on iou_room.id = iou.room_id
    join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
    join public.spell_cards card on card.id = sdi.card_id
   where r.id = p_round_id
     and not exists (
       select 1 from public.rolls ro
        where ro.round_id = r.id and ro.layer = 0
     )
     and iou.id <> r.id
     and iou.status = 'resolved'
     and iou.resolved_at < coalesce(r.closed_at, now())
     and iou_room.is_test = room.is_test
     and not exists (
       select 1 from public.rounds paid
        where paid.brewer_source = 'brew_debt'
          and paid.brewer_source_cast_id = sc.id
          and paid.id <> r.id
     )
     and not exists (
       select 1 from public._rr_active_effects_as_of(r.room_id, r.id) sae
        where sae.effect_kind = 'brewer_immunity'
          and sae.target_player_id = rp.player_id
     )
   order by iou.resolved_at, sc.cast_at, sc.seq
   limit 1;
$$;

revoke execute on function public._brew_debt_due(uuid) from public, anon, authenticated;
-- The integration suites read it directly with the service role.
grant execute on function public._brew_debt_due(uuid) to service_role;

comment on function public._brew_debt_due(uuid) is
  'Issue #432 (spec #401): the Brew Debt this round pays -- { debtor_player_id, cast_id, card_name, brew_iou_round_id } -- or null when it is not a debt round. Derived: a round recorded (brew_iou, cast) and none has recorded (brew_debt, cast), across all of the Debtor''s rooms (never Test Room <-> real). Only while the round has no layer-0 roll; the Debtor must be a non-excluded Participant without Brewer Immunity; oldest debt first. Internal.';
