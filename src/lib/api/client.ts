import type { SupabaseClient } from "@supabase/supabase-js";
import type { paths } from "./schema";

type ActingAsResponse =
  paths["/acting-as"]["get"]["responses"][200]["content"]["application/json"];
type OrderResponse =
  paths["/rounds/{roundId}/order"]["get"]["responses"][200]["content"]["application/json"];

type EnterRoomResponse =
  paths["/rooms/today/entry"]["post"]["responses"][200]["content"]["application/json"];

type RatingIdResponse =
  paths["/brew-ratings/{roundId}"]["put"]["responses"][200]["content"]["application/json"];

type AdjustmentIdResponse =
  paths["/modifier-adjustments"]["post"]["responses"][200]["content"]["application/json"];

// The advance/finalize endpoints return SQL's own outcome jsonb unchanged (the
// shadow passes SQL's payload through); callers map it with toLayerOutcome.
export type AdvanceOutcomeResponse =
  paths["/rounds/{roundId}/advance"]["post"]["responses"][200]["content"]["application/json"];

export type RoomViewResponse =
  paths["/rooms/{roomId}/view"]["get"]["responses"][200]["content"]["application/json"];

export type RoundRecapResponse =
  paths["/rounds/{roundId}/recap"]["get"]["responses"][200]["content"]["application/json"];

type StartRoundResponse =
  paths["/rounds"]["post"]["responses"][200]["content"]["application/json"];

/** `version` is the bumped rooms.version, or null when the command changed nothing. */
export type CommandResponse =
  paths["/rounds/{roundId}/close"]["post"]["responses"][200]["content"]["application/json"];

/** A roll submission's answer: the value that was recorded, and the bumped rooms.version. */
export type RollResponse = { value: number; version: number | null };

type BackfillResponse =
  paths["/rounds/backfill"]["post"]["responses"][200]["content"]["application/json"];

/** A refusal from the API: its problem+json `code` and `detail`, for wrappers that switch on them. */
export class ApiError extends Error {
  constructor(
    path: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: string,
    title?: string,
  ) {
    super(`API ${path} failed: ${status} ${code ?? title ?? ""}`.trim());
    this.name = "ApiError";
  }
}

export interface ApiClient {
  getActingAs(): Promise<ActingAsResponse>;
  submitBrewRating(roundId: string, score: number): Promise<RatingIdResponse>;
  withdrawBrewRating(roundId: string): Promise<void>;
  rateSpellCard(cardId: string, score: number): Promise<RatingIdResponse>;
  withdrawSpellCardRating(cardId: string): Promise<void>;
  submitOrder(roundId: string, drinkType: string): Promise<void>;
  getMyOrderForRound(roundId: string): Promise<OrderResponse>;
  getMyMostRecentOrder(): Promise<OrderResponse>;
  logModifierAdjustment(targetPlayerId: string, delta: number, reason: string): Promise<AdjustmentIdResponse>;
  deleteModifierAdjustment(adjustmentId: string): Promise<void>;
  adminDeleteModifierAdjustment(adjustmentId: string, reason: string): Promise<void>;
  advanceLayer(roundId: string): Promise<AdvanceOutcomeResponse>;
  finalizeLayer(roundId: string): Promise<AdvanceOutcomeResponse>;
  getRoomView(roomId: string): Promise<RoomViewResponse>;
  enterTodaysRoom(): Promise<EnterRoomResponse>;
  setActingAs(targetPlayerId: string): Promise<void>;
  getRoundRecap(roundId: string): Promise<RoundRecapResponse>;
  startRound(roomId?: string): Promise<StartRoundResponse>;
  declareIn(roundId: string): Promise<CommandResponse>;
  declareInLate(roundId: string): Promise<CommandResponse>;
  withdrawDeclaration(roundId: string): Promise<CommandResponse>;
  closeRound(roundId: string): Promise<CommandResponse>;
  cancelRound(roundId: string): Promise<CommandResponse>;
  excludeRoundParticipant(roundId: string, playerId: string, layer: number): Promise<CommandResponse>;
  confirmRoundReplay(roundId: string): Promise<CommandResponse>;
  declineRoundReplay(roundId: string): Promise<CommandResponse>;
  submitRoll(roundId: string): Promise<RollResponse>;
  submitManualRoll(roundId: string, value: number): Promise<RollResponse>;
  submitRollAs(roundId: string, playerId: string): Promise<RollResponse>;
  submitManualRollAs(roundId: string, playerId: string, value: number): Promise<RollResponse>;
  adminProxyRoll(roundId: string, playerId: string, value: number): Promise<RollResponse>;
  adminBackfillRound(
    participantIds: string[],
    layers: { playerId: string; value: number }[][],
  ): Promise<BackfillResponse>;
}

export function createApiClient(
  baseUrl: string,
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await getToken();
    if (!token) throw new Error("API call needs a signed-in session");
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    if (!res.ok) {
      const problem = await res.json().catch(() => null);
      throw new ApiError(path, res.status, problem?.code, problem?.detail, problem?.title);
    }
    return res;
  }
  async function get<T>(path: string): Promise<T> {
    return (await (await call("GET", path)).json()) as T;
  }
  return {
    getActingAs: () => get<ActingAsResponse>("/acting-as"),
    submitBrewRating: async (roundId, score) =>
      (await (await call("PUT", `/brew-ratings/${roundId}`, { score })).json()) as RatingIdResponse,
    withdrawBrewRating: async (roundId) => {
      await call("DELETE", `/brew-ratings/${roundId}`);
    },
    rateSpellCard: async (cardId, score) =>
      (await (await call("PUT", `/spell-card-ratings/${cardId}`, { score })).json()) as RatingIdResponse,
    withdrawSpellCardRating: async (cardId) => {
      await call("DELETE", `/spell-card-ratings/${cardId}`);
    },
    submitOrder: async (roundId, drinkType) => {
      await call("PUT", `/rounds/${roundId}/order`, { drinkType });
    },
    getMyOrderForRound: (roundId) => get<OrderResponse>(`/rounds/${roundId}/order`),
    getMyMostRecentOrder: () => get<OrderResponse>("/orders/latest"),
    logModifierAdjustment: async (targetPlayerId, delta, reason) =>
      (await (await call("POST", "/modifier-adjustments", { targetPlayerId, delta, reason })).json()) as AdjustmentIdResponse,
    deleteModifierAdjustment: async (adjustmentId) => {
      await call("DELETE", `/modifier-adjustments/${adjustmentId}`);
    },
    adminDeleteModifierAdjustment: async (adjustmentId, reason) => {
      await call("POST", `/modifier-adjustments/${adjustmentId}/admin-delete`, { reason });
    },
    advanceLayer: async (roundId) =>
      (await (await call("POST", `/rounds/${roundId}/advance`)).json()) as AdvanceOutcomeResponse,
    finalizeLayer: async (roundId) =>
      (await (await call("POST", `/rounds/${roundId}/finalize`)).json()) as AdvanceOutcomeResponse,
    getRoomView: (roomId) => get<RoomViewResponse>(`/rooms/${encodeURIComponent(roomId)}/view`),
    enterTodaysRoom: async () => (await (await call("POST", "/rooms/today/entry")).json()) as EnterRoomResponse,
    setActingAs: async (targetPlayerId) => {
      await call("PUT", "/acting-as", { targetPlayerId });
    },
    getRoundRecap: (roundId) => get<RoundRecapResponse>(`/rounds/${roundId}/recap`),
    startRound: async (roomId) =>
      (await (await call("POST", "/rounds", { roomId: roomId ?? null })).json()) as StartRoundResponse,
    declareIn: async (roundId) => (await (await call("POST", `/rounds/${roundId}/declaration`)).json()) as CommandResponse,
    declareInLate: async (roundId) => (await (await call("POST", `/rounds/${roundId}/declaration/late`)).json()) as CommandResponse,
    withdrawDeclaration: async (roundId) => (await (await call("DELETE", `/rounds/${roundId}/declaration`)).json()) as CommandResponse,
    closeRound: async (roundId) => (await (await call("POST", `/rounds/${roundId}/close`)).json()) as CommandResponse,
    cancelRound: async (roundId) => (await (await call("POST", `/rounds/${roundId}/cancel`)).json()) as CommandResponse,
    excludeRoundParticipant: async (roundId, playerId, layer) =>
      (await (await call("POST", `/rounds/${roundId}/exclusions`, { playerId, layer })).json()) as CommandResponse,
    confirmRoundReplay: async (roundId) => (await (await call("POST", `/rounds/${roundId}/replay/confirm`)).json()) as CommandResponse,
    declineRoundReplay: async (roundId) => (await (await call("POST", `/rounds/${roundId}/replay/decline`)).json()) as CommandResponse,
    submitRoll: async (roundId) => (await (await call("POST", `/rounds/${roundId}/rolls`)).json()) as RollResponse,
    submitManualRoll: async (roundId, value) =>
      (await (await call("POST", `/rounds/${roundId}/rolls/manual`, { value })).json()) as RollResponse,
    submitRollAs: async (roundId, playerId) =>
      (await (await call("POST", `/rounds/${roundId}/rolls/as`, { playerId })).json()) as RollResponse,
    submitManualRollAs: async (roundId, playerId, value) =>
      (await (await call("POST", `/rounds/${roundId}/rolls/manual/as`, { playerId, value })).json()) as RollResponse,
    adminProxyRoll: async (roundId, playerId, value) =>
      (await (await call("POST", `/rounds/${roundId}/rolls/proxy`, { playerId, value })).json()) as RollResponse,
    adminBackfillRound: async (participantIds, layers) =>
      (await (await call("POST", "/rounds/backfill", { participantIds, layers })).json()) as BackfillResponse,
  };
}

export function apiClientFor(supabase: SupabaseClient): ApiClient {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new Error("NEXT_PUBLIC_API_URL must be set to use a ported (API) path.");
  return createApiClient(base, async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);
}
