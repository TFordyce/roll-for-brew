import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiClient } from "@/lib/api/client";
import { createApiClient } from "@/lib/api/client";
import { adminDeleteModifierAdjustment, deleteModifierAdjustment, logModifierAdjustment } from "./modifierAdjustments";

type Row = { room_id: string | null; enabled: boolean };
function fake(rows: Row[]) {
  const rpc = vi.fn(async () => ({ data: "rpc-id", error: null }));
  const from = vi.fn(() => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }));
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc };
}
function fakeApi() {
  return {
    logModifierAdjustment: vi.fn(async () => ({ id: "api-id" })),
    deleteModifierAdjustment: vi.fn(async () => {}),
    adminDeleteModifierAdjustment: vi.fn(async () => {}),
  } as unknown as ApiClient & Record<string, ReturnType<typeof vi.fn>>;
}
const ON: Row[] = [{ room_id: null, enabled: true }];

describe("modifier adjustment wrappers flag branches", () => {
  it("logModifierAdjustment: rpc when off, API when on", async () => {
    const api = fakeApi();
    const off = fake([]);
    expect(await logModifierAdjustment(off.supabase, "p1", 2, "why", () => api)).toBe("rpc-id");
    expect(off.rpc).toHaveBeenCalledWith("log_modifier_adjustment", { p_target_player_id: "p1", p_delta: 2, p_reason: "why" });
    const on = fake(ON);
    expect(await logModifierAdjustment(on.supabase, "p1", 2, "why", () => api)).toBe("api-id");
    expect(api.logModifierAdjustment).toHaveBeenCalledWith("p1", 2, "why");
    expect(on.rpc).not.toHaveBeenCalled();
  });
  it("deleteModifierAdjustment: rpc when off, API when on", async () => {
    const api = fakeApi();
    const off = fake([]);
    await deleteModifierAdjustment(off.supabase, "a1", () => api);
    expect(off.rpc).toHaveBeenCalledWith("delete_modifier_adjustment", { p_adjustment_id: "a1" });
    const on = fake(ON);
    await deleteModifierAdjustment(on.supabase, "a1", () => api);
    expect(api.deleteModifierAdjustment).toHaveBeenCalledWith("a1");
    expect(on.rpc).not.toHaveBeenCalled();
  });
  it("adminDeleteModifierAdjustment: rpc when off, API when on", async () => {
    const api = fakeApi();
    const off = fake([]);
    await adminDeleteModifierAdjustment(off.supabase, "a1", "dup", () => api);
    expect(off.rpc).toHaveBeenCalledWith("admin_delete_modifier_adjustment", { p_adjustment_id: "a1", p_reason: "dup" });
    const on = fake(ON);
    await adminDeleteModifierAdjustment(on.supabase, "a1", "dup", () => api);
    expect(api.adminDeleteModifierAdjustment).toHaveBeenCalledWith("a1", "dup");
    expect(on.rpc).not.toHaveBeenCalled();
  });
  it("a read error on port_flags falls back to rpc", async () => {
    const rpc = vi.fn(async () => ({ data: "rpc-id", error: null }));
    const from = vi.fn(() => ({ select: () => ({ eq: async () => ({ data: null, error: { message: "x" } }) }) }));
    const supabase = { from, rpc } as unknown as SupabaseClient;
    expect(await logModifierAdjustment(supabase, "p1", 1, "r", () => fakeApi())).toBe("rpc-id");
  });
});

describe("modifier adjustment API client calls", () => {
  it("POST, DELETE and admin-delete hit the right paths with JSON bodies", async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" && String(_u).endsWith("/modifier-adjustments")
        ? new Response(JSON.stringify({ id: "x" }), { status: 200 })
        : new Response(null, { status: 204 }));
    const c = createApiClient("https://api.test", async () => "jwt", f as unknown as typeof fetch);
    expect(await c.logModifierAdjustment("p1", -1, "why")).toEqual({ id: "x" });
    expect(f).toHaveBeenCalledWith("https://api.test/modifier-adjustments", expect.objectContaining({
      method: "POST", body: JSON.stringify({ targetPlayerId: "p1", delta: -1, reason: "why" }),
    }));
    await c.deleteModifierAdjustment("a1");
    expect(f).toHaveBeenCalledWith("https://api.test/modifier-adjustments/a1", expect.objectContaining({ method: "DELETE" }));
    await c.adminDeleteModifierAdjustment("a1", "dup");
    expect(f).toHaveBeenCalledWith("https://api.test/modifier-adjustments/a1/admin-delete", expect.objectContaining({
      method: "POST", body: JSON.stringify({ reason: "dup" }),
    }));
  });
});
