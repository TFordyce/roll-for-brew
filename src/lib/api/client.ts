import type { SupabaseClient } from "@supabase/supabase-js";
import type { paths } from "./schema";

type ActingAsResponse =
  paths["/acting-as"]["get"]["responses"][200]["content"]["application/json"];

/**
 * Thin fetch wrapper over the C# API (api/, spec #533). Types come from the committed
 * `schema.d.ts` (regenerate with `npm run gen:api`; CI fails on drift). Sends the Supabase
 * session JWT as Bearer. Add one method per ported endpoint here.
 */
export type RoomViewResponse =
  paths["/rooms/{roomId}/view"]["get"]["responses"][200]["content"]["application/json"];

export interface ApiClient {
  getActingAs(): Promise<ActingAsResponse>;
  /** GET /rooms/{id}/view (slice 1b): the per-viewer screen model. Sent with cache: no-store. */
  getRoomView(roomId: string): Promise<RoomViewResponse>;
}

export function createApiClient(
  baseUrl: string,
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  async function get<T>(path: string): Promise<T> {
    const token = await getToken();
    if (!token) throw new Error("API call needs a signed-in session");
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      const problem = await res.json().catch(() => null);
      throw new Error(`API ${path} failed: ${res.status} ${problem?.code ?? problem?.title ?? ""}`.trim());
    }
    return (await res.json()) as T;
  }
  return {
    getActingAs: () => get<ActingAsResponse>("/acting-as"),
    getRoomView: (roomId) => get<RoomViewResponse>(`/rooms/${encodeURIComponent(roomId)}/view`),
  };
}

/** The app's API client, authenticated with the given Supabase client's session. */
export function apiClientFor(supabase: SupabaseClient): ApiClient {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) throw new Error("NEXT_PUBLIC_API_URL must be set to use a ported (API) path.");
  return createApiClient(base, async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);
}
