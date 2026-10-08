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

/**
 * Thin fetch wrapper over the C# API (api/, spec #533). Types come from the committed
 * `schema.d.ts` (regenerate with `npm run gen:api`; CI fails on drift). Sends the Supabase
 * session JWT as Bearer. Add one method per ported endpoint here.
 */
export interface ApiClient {
  getActingAs(): Promise<ActingAsResponse>;
  submitBrewRating(roundId: string, score: number): Promise<RatingIdResponse>;
  withdrawBrewRating(roundId: string): Promise<void>;
  rateSpellCard(cardId: string, score: number): Promise<RatingIdResponse>;
  withdrawSpellCardRating(cardId: string): Promise<void>;
  submitOrder(roundId: string, drinkType: string): Promise<void>;
  getMyOrderForRound(roundId: string): Promise<OrderResponse>;
  getMyMostRecentOrder(): Promise<OrderResponse>;
  enterTodaysRoom(): Promise<EnterRoomResponse>;
  setActingAs(targetPlayerId: string | null): Promise<void>;
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
    });
    if (!res.ok) {
      const problem = await res.json().catch(() => null);
      throw new Error(`API ${path} failed: ${res.status} ${problem?.code ?? problem?.title ?? ""}`.trim());
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
    enterTodaysRoom: async () => (await (await call("POST", "/rooms/today/entry")).json()) as EnterRoomResponse,
    setActingAs: async (targetPlayerId) => {
      await call("PUT", "/acting-as", { targetPlayerId });
    },
  };
}

/** The app's API client, authenticated with the given Supabase client's session. */
export function apiClientFor(supabase: SupabaseClient): ApiClient {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new Error("NEXT_PUBLIC_API_URL must be set to use a ported (API) path.");
  return createApiClient(base, async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);
}
