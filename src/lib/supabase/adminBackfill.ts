import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError, apiClientFor, type ApiClient } from "@/lib/api/client";
import { isPortEnabled } from "@/lib/api/portFlags";

export type BackfillRollEntry = { playerId: string; value: number };
export type BackfillLayer = BackfillRollEntry[];

export async function getTodaysModifiers(
  supabase: SupabaseClient,
  playerIds: string[],
): Promise<Record<string, number>> {
  if (playerIds.length === 0) return {};

  const { data, error } = await supabase.rpc("get_todays_modifiers", { p_player_ids: playerIds });
  if (error) throw error;

  const rows = (data ?? []) as { player_id: string; modifier: number }[];
  return Object.fromEntries(rows.map((row) => [row.player_id, row.modifier]));
}

export async function adminBackfillRound(
  supabase: SupabaseClient,
  participantIds: string[],
  layers: BackfillLayer[],
  api: () => ApiClient = () => apiClientFor(supabase),
): Promise<string> {
  if (await isPortEnabled(supabase, "adminBackfillRound")) {
    return (await api().adminBackfillRound(participantIds, layers)).roundId;
  }

  const { data, error } = await supabase.rpc("admin_backfill_round", {
    p_participant_ids: participantIds,
    p_layers: layers.map((layer) => layer.map((entry) => ({ player_id: entry.playerId, value: entry.value }))),
  });
  if (error) throw error;
  return data as string;
}

// The rpc's SQLSTATEs, and the API's problem codes for them while the flag can still roll back.
const KNOWN_REFUSALS = new Set([
  "RFB33", "RFB34", "RFB35", "RFB36", "RFB37", "RFB38", "RFB39", "RFB40",
  "admin_required_backfill",
  "backfill_too_few_participants",
  "backfill_no_layers",
  "backfill_round_in_progress",
  "backfill_layer_roster_mismatch",
  "backfill_roll_out_of_range",
  "backfill_extra_layer",
  "backfill_layer_still_tied",
]);

/** The sentence the form shows for a known refusal, or null when the error should throw. */
export function backfillFailureMessage(error: unknown): string | null {
  const code = (error as { code?: string } | null)?.code;
  if (!code || !KNOWN_REFUSALS.has(code)) return null;
  const raw = (error instanceof ApiError ? error.detail : (error as { message?: string }).message) ?? "";
  const message = raw.replace(/^admin_backfill_round:\s*/, "");
  return message ? message.charAt(0).toUpperCase() + message.slice(1) + "." : "Could not backfill that round.";
}
