import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "@/lib/api/client";
import { createApiClient } from "@/lib/api/client";
import { submitBrewRating, withdrawBrewRating } from "./brewRatings";
import { rateSpellCard, withdrawSpellCardRating } from "./spellCardRatings";

type Row = { room_id: string | null; enabled: boolean };
function fake(rows: Row[]) {
  const rpc = vi.fn(async () => ({ data: "rpc-id", error: null }));
  const from = vi.fn(() => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }));
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc };
}
function fakeApi() {
  return {
    submitBrewRating: vi.fn(async () => ({ id: "api-id" })),
    withdrawBrewRating: vi.fn(async () => {}),
    rateSpellCard: vi.fn(async () => ({ id: "api-id" })),
    withdrawSpellCardRating: vi.fn(async () => {}),
  } as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;
}
const ON: Row[] = [{ room_id: null, enabled: true }];

describe("rating wrappers flag branches", () => {
  it("submitBrewRating: rpc when off, API when on", async () => {
    const off = fake([]);
    const api = fakeApi();
    expect(await submitBrewRating(off.supabase, "r1", 4, () => api)).toBe("rpc-id");
    expect(off.rpc).toHaveBeenCalledWith("submit_brew_rating", { p_round_id: "r1", p_score: 4 });
    const on = fake(ON);
    expect(await submitBrewRating(on.supabase, "r1", 4, () => api)).toBe("api-id");
    expect(api.submitBrewRating).toHaveBeenCalledWith("r1", 4);
    expect(on.rpc).not.toHaveBeenCalled();
  });
  it("withdrawBrewRating: rpc when off, API when on", async () => {
    const off = fake([]);
    const api = fakeApi();
    await withdrawBrewRating(off.supabase, "r1", () => api);
    expect(off.rpc).toHaveBeenCalledWith("withdraw_brew_rating", { p_round_id: "r1" });
    const on = fake(ON);
    await withdrawBrewRating(on.supabase, "r1", () => api);
    expect(api.withdrawBrewRating).toHaveBeenCalledWith("r1");
    expect(on.rpc).not.toHaveBeenCalled();
  });
  it("rateSpellCard: rpc when off, API when on", async () => {
    const off = fake([]);
    const api = fakeApi();
    expect(await rateSpellCard(off.supabase, "c1", 5, () => api)).toBe("rpc-id");
    expect(off.rpc).toHaveBeenCalledWith("rate_spell_card", { p_card_id: "c1", p_score: 5 });
    expect(await rateSpellCard(fake(ON).supabase, "c1", 5, () => api)).toBe("api-id");
    expect(api.rateSpellCard).toHaveBeenCalledWith("c1", 5);
  });
  it("withdrawSpellCardRating: rpc when off, API when on", async () => {
    const off = fake([]);
    const api = fakeApi();
    await withdrawSpellCardRating(off.supabase, "c1", () => api);
    expect(off.rpc).toHaveBeenCalledWith("withdraw_spell_card_rating", { p_card_id: "c1" });
    await withdrawSpellCardRating(fake(ON).supabase, "c1", () => api);
    expect(api.withdrawSpellCardRating).toHaveBeenCalledWith("c1");
  });
  it("a read error on port_flags falls back to rpc", async () => {
    const rpc = vi.fn(async () => ({ data: "rpc-id", error: null }));
    const from = vi.fn(() => ({ select: () => ({ eq: async () => ({ data: null, error: { message: "x" } }) }) }));
    const supabase = { from, rpc } as unknown as SupabaseClient;
    expect(await rateSpellCard(supabase, "c1", 3, () => fakeApi())).toBe("rpc-id");
  });
});

describe("rating API client calls", () => {
  it("PUT with a JSON body and DELETE hit the right paths", async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ id: "x" }), { status: 200 }));
    const c = createApiClient("https://api.test", async () => "jwt", f as unknown as typeof fetch);
    expect(await c.submitBrewRating("r1", 3)).toEqual({ id: "x" });
    expect(f).toHaveBeenCalledWith("https://api.test/brew-ratings/r1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ score: 3 }) }));
    await c.withdrawBrewRating("r1");
    expect(f).toHaveBeenCalledWith("https://api.test/brew-ratings/r1", expect.objectContaining({ method: "DELETE" }));
    await c.rateSpellCard("c1", 2);
    expect(f).toHaveBeenCalledWith("https://api.test/spell-card-ratings/c1", expect.objectContaining({ method: "PUT" }));
    await c.withdrawSpellCardRating("c1");
    expect(f).toHaveBeenCalledWith("https://api.test/spell-card-ratings/c1", expect.objectContaining({ method: "DELETE" }));
  });
});
