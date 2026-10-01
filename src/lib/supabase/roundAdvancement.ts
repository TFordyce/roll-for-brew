import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundRevealedPayload } from "@/lib/supabase/realtime";

export type RevealedRoll = RoundRevealedPayload["rolls"][number];

/**
 * Why a locked read found nothing to do — the closed set finalize_layer's and
 * advance_layer's `comment on` document.
 */
export type NoopReason =
  | "round_not_found"
  | "round_not_closed"
  | "no_window"
  | "window_open"
  | "layer_incomplete"
  // Issue #430: layer 0 is rolled, but a Tea Party Revolt pick is outstanding.
  | "revolt_pick_pending";

/** The two ends of Layer finalization, or a noop — what finalize_layer returns. */
export type FinalizationOutcome =
  | {
      outcome: "brewer";
      layer: number;
      brewerId: string;
      cupsMade: number;
      /** The Layer's final (post-transform) rolls, for the reveal broadcast. */
      rolls: RevealedRoll[];
      replayPending: boolean;
    }
  | {
      outcome: "tie";
      /** The new Tie-Break Reroll Layer. */
      layer: number;
      tiedPlayerIds: string[];
      /**
       * Issue #431: a Loose Leaf roll-off, committed the way a tie is — the
       * named holder and the second-lowest roller reroll at the new Layer.
       */
      rolloff?: boolean;
    }
  | { outcome: "noop"; reason: NoopReason };

/** A completed Layer's raw (pre-transform) rolls, for the "layer rolls revealed" broadcast. */
export type LayerRolls = { layer: number; rolls: RevealedRoll[] };

/**
 * What one round-advancement SQL call did (ADR 0008). `brewer` and `tie` are
 * the two ends of Layer finalization; `windowOpened` is advance_layer opening
 * Layer 0's reaction window (with the finalization outcome too, when nobody
 * could react and it closed on the spot); `noop` means the locked read found
 * nothing to do (window still open, Layer incomplete, round already moved on).
 * `layerRolls` is present only on the call that first found the Layer complete.
 */
export type LayerOutcome = (
  | FinalizationOutcome
  | {
      outcome: "windowOpened";
      layer: number;
      windowClosed: boolean;
      /** Layer finalization's outcome when the window closed straight away; null while it's open. */
      finalization: FinalizationOutcome | null;
    }
) & { layerRolls?: LayerRolls };

type RawRoll = { player_id: string; value: number; discarded_value: number | null; entered_by_admin: boolean };

type RawFinalizationOutcome =
  | {
      outcome: "brewer";
      layer: number;
      brewer_id: string;
      cups_made: number;
      rolls: RawRoll[];
      replay_pending: boolean;
    }
  | { outcome: "tie"; layer: number; tied_player_ids: string[]; rolloff?: boolean }
  | { outcome: "noop"; reason: NoopReason };

type RawLayerOutcome = (
  | RawFinalizationOutcome
  | { outcome: "windowOpened"; layer: number; window_closed: boolean; finalization: RawFinalizationOutcome | null }
) & { layer_rolls?: { layer: number; rolls: RawRoll[] } };

function toRevealedRolls(rolls: RawRoll[]): RevealedRoll[] {
  return rolls.map((r) => ({
    playerId: r.player_id,
    value: r.value,
    discardedValue: r.discarded_value,
    enteredByAdmin: r.entered_by_admin,
  }));
}

function toFinalizationOutcome(raw: RawFinalizationOutcome): FinalizationOutcome {
  switch (raw.outcome) {
    case "brewer":
      return {
        outcome: "brewer",
        layer: raw.layer,
        brewerId: raw.brewer_id,
        cupsMade: raw.cups_made,
        rolls: toRevealedRolls(raw.rolls),
        replayPending: raw.replay_pending,
      };
    case "tie":
      return { outcome: "tie", layer: raw.layer, tiedPlayerIds: raw.tied_player_ids, rolloff: raw.rolloff ?? false };
    case "noop":
      return { outcome: "noop", reason: raw.reason };
  }
}

function toLayerOutcome(raw: RawLayerOutcome): LayerOutcome {
  const outcome: LayerOutcome =
    raw.outcome === "windowOpened"
      ? {
          outcome: "windowOpened",
          layer: raw.layer,
          windowClosed: raw.window_closed,
          finalization: raw.finalization ? toFinalizationOutcome(raw.finalization) : null,
        }
      : toFinalizationOutcome(raw);
  if (raw.layer_rolls) {
    outcome.layerRolls = { layer: raw.layer_rolls.layer, rolls: toRevealedRolls(raw.layer_rolls.rolls) };
  }
  return outcome;
}

/**
 * Calls finalize_layer (db/sql/functions/finalize_layer.sql, issue #414):
 * Layer finalization in one locked transaction — the eager roll-input shim,
 * resolve_round, and the brewer/tie commit — or a noop when the round can't
 * finalize yet. Never raises for who the caller is or for losing a race.
 */
export async function finalizeLayer(supabase: SupabaseClient, roundId: string): Promise<LayerOutcome> {
  const { data, error } = await supabase.rpc("finalize_layer", { p_round_id: roundId });
  if (error) throw error;
  return toLayerOutcome(data as RawLayerOutcome);
}

/**
 * Calls advance_layer (db/sql/functions/advance_layer.sql, issue #415): once
 * the current Layer is complete, opens Layer 0's reaction window (finalizing
 * in the same call when nobody can react), or performs Layer finalization
 * behind a closed window or at a Tie-Break Reroll Layer — or a noop. Never
 * opens a second window, and never raises for who the caller is or for
 * losing a race.
 */
export async function advanceLayer(supabase: SupabaseClient, roundId: string): Promise<LayerOutcome> {
  const { data, error } = await supabase.rpc("advance_layer", { p_round_id: roundId });
  if (error) throw error;
  return toLayerOutcome(data as RawLayerOutcome);
}
