import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

describe("getRoomView", () => {
  it("GETs /rooms/{id}/view with the Bearer JWT and no-store", async () => {
    const body = { version: 3, room: { roomId: "r1" }, viewer: { playerId: "p1" } };
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const c = createApiClient("https://api.test/", async () => "jwt", f as unknown as typeof fetch);

    expect(await c.getRoomView("r1")).toEqual(body);
    expect(f).toHaveBeenCalledWith(
      "https://api.test/rooms/r1/view",
      expect.objectContaining({ cache: "no-store", headers: expect.objectContaining({ Authorization: "Bearer jwt" }) }),
    );
  });

  it("surfaces the problem code of a missing room", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: "room_not_found" }), { status: 404 }));
    const c = createApiClient("https://api.test", async () => "jwt", f as unknown as typeof fetch);
    await expect(c.getRoomView("nope")).rejects.toThrow(/404 room_not_found/);
  });
});
