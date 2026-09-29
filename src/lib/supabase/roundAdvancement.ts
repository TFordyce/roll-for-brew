import type { SupabaseClient } from "@supabase/supabase-js";

export type RevealedRoll = {
  playerId: string;
  value: number;
  discardedValue: number | null;
  enteredByAdmin: boolean;
};

/**
 * What one round-advancement SQL call did (ADR 0008). `brewer` and `tie` are
 * the two ends of Layer finalization; `noop` means the locked read found
 * nothing to do (window still open, Layer incomplete, round already moved on).
 */
export type LayerOutcome =
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
    }
  | { outcome: "noop"; reason: string };

type RawLayerOutcome =
  | {
      outcome: "brewer";
      layer: number;
      brewer_id: string;
      cups_made: number;
      rolls: { player_id: string; value: number; discarded_value: number | null; entered_by_admin: boolean }[];
      replay_pending: boolean;
    }
  | { outcome: "tie"; layer: number; tied_player_ids: string[] }
  | { outcome: "noop"; reason: string };

function toLayerOutcome(raw: RawLayerOutcome): LayerOutcome {
  switch (raw.outcome) {
    case "brewer":
      return {
        outcome: "brewer",
        layer: raw.layer,
        brewerId: raw.brewer_id,
        cupsMade: raw.cups_made,
        rolls: raw.rolls.map((r) => ({
          playerId: r.player_id,
          value: r.value,
          discardedValue: r.discarded_value,
          enteredByAdmin: r.entered_by_admin,
        })),
        replayPending: raw.replay_pending,
      };
    case "tie":
      return { outcome: "tie", layer: raw.layer, tiedPlayerIds: raw.tied_player_ids };
    case "noop":
      return { outcome: "noop", reason: raw.reason };
  }
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
