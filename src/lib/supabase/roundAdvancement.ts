import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoundRevealedPayload } from "@/lib/supabase/realtime";

export type RevealedRoll = RoundRevealedPayload["rolls"][number];

export type NoopReason =
  | "round_not_found"
  | "round_not_closed"
  | "no_window"
  | "window_open"
  | "layer_incomplete"
  | "revolt_pick_pending";

export type FinalizationOutcome =
  | {
      outcome: "brewer";
      layer: number;
      brewerId: string;
      cupsMade: number;
      rolls: RevealedRoll[];
      replayPending: boolean;
    }
  | {
      outcome: "tie";
      layer: number;
      tiedPlayerIds: string[];
      rolloff: boolean;
    }
  | { outcome: "noop"; reason: NoopReason };

export type LayerRolls = { layer: number; rolls: RevealedRoll[] };

export type LayerOutcome = (
  | FinalizationOutcome
  | {
      outcome: "windowOpened";
      layer: number;
      windowClosed: boolean;
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

export async function finalizeLayer(supabase: SupabaseClient, roundId: string): Promise<LayerOutcome> {
  const { data, error } = await supabase.rpc("finalize_layer", { p_round_id: roundId });
  if (error) throw error;
  return toLayerOutcome(data as RawLayerOutcome);
}

export async function advanceLayer(supabase: SupabaseClient, roundId: string): Promise<LayerOutcome> {
  const { data, error } = await supabase.rpc("advance_layer", { p_round_id: roundId });
  if (error) throw error;
  return toLayerOutcome(data as RawLayerOutcome);
}
