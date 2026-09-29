-- Issue #407 (spec #402, ADR 0007): the Resolution Summary.
--
-- A sibling of rounds.resolution_trace holding the resolver's own layer-0
-- per-player final values, so the roll row renders what the resolver decided
-- instead of recomposing it in TypeScript. One entry per layer-0 roller:
--
--   { player_id, roll, snapshot, composed, total, nat, dice_reduced }
--
--   roll          final roll, after every roll-input transform
--   snapshot      roll-time modifier (rolls.modifier_snapshot)
--   composed      final composed modifier
--   total         roll + composed
--   nat           'nat1' | 'nat20' | null, as _rr_pick_lowest judged it
--   dice_reduced  a Calami-Tea tick floored this roll (so a 1 is not a nat 1)
--
-- Written by resolve_round at the same two layer-0 exits as the Trace (tie
-- and brewer); tie-break layers write none. The Trace's shape is unchanged.
-- No backfill: rounds resolved before this have a null summary and render
-- the degraded row (ADR 0007).

alter table public.rounds
  add column resolution_summary jsonb;

comment on column public.rounds.resolution_summary is
  'Issue #407 / ADR 0007: layer-0 Resolution Summary written by resolve_round beside resolution_trace -- one { player_id, roll, snapshot, composed, total, nat, dice_reduced } entry per layer-0 roller. Null for rounds resolved before it existed (no backfill).';
