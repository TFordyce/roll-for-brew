import { beforeEach, describe, expect, it, vi } from "vitest";

const allocateSpellCard = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/adminCards", () => ({ allocateSpellCard, unassignSpellCard: vi.fn() }));

const { allocateSpellCardAction } = await import("./actions");

function submit(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [k, v] of Object.entries(fields)) formData.set(k, v);
  return allocateSpellCardAction({ status: "idle" }, formData);
}

describe("allocateSpellCardAction with a live Stale Biscuit mark (issue #471)", () => {
  beforeEach(() => {
    allocateSpellCard.mockReset();
  });

  it("turns RFB57 into a mark warning naming the beneficiary", async () => {
    allocateSpellCard.mockRejectedValue({
      code: "RFB57",
      message: "admin_allocate_spell_card: that player has a live Stale Biscuit mark from Milo",
      details: "p-marker",
    });

    expect(await submit({ cardId: "c1", playerId: "p-target" })).toEqual({
      status: "mark_warning",
      playerId: "p-target",
      beneficiaryId: "p-marker",
      message: "That player has a live Stale Biscuit mark from Milo.",
    });
    expect(allocateSpellCard).toHaveBeenCalledWith({}, "c1", "p-target", undefined);
  });

  it("cancel allocates nothing", async () => {
    expect(await submit({ cardId: "c1", playerId: "p-target", markChoice: "cancel" })).toEqual({ status: "idle" });
    expect(allocateSpellCard).not.toHaveBeenCalled();
  });

  it.each(["target", "beneficiary"] as const)("passes the %s choice through", async (choice) => {
    allocateSpellCard.mockResolvedValue({ recipientPlayerId: "p-target", drawRedirectOutcome: null });

    expect(await submit({ cardId: "c1", playerId: "p-target", markChoice: choice })).toEqual({ status: "idle" });
    expect(allocateSpellCard).toHaveBeenCalledWith({}, "c1", "p-target", choice);
  });

  it("says so when the beneficiary option fizzled", async () => {
    allocateSpellCard.mockResolvedValue({ recipientPlayerId: "p-target", drawRedirectOutcome: "fizzled" });

    const state = await submit({ cardId: "c1", playerId: "p-target", markChoice: "beneficiary" });
    expect(state).toMatchObject({ status: "notice", message: expect.stringContaining("fizzled") });
  });

  it("a mark spent since the warning (RFB58) is a retryable error", async () => {
    allocateSpellCard.mockRejectedValue({
      code: "RFB58",
      message: "admin_allocate_spell_card: that player no longer has a live Stale Biscuit mark",
    });

    expect(await submit({ cardId: "c1", playerId: "p-target", markChoice: "beneficiary" })).toEqual({
      status: "error",
      message: "That player no longer has a live Stale Biscuit mark.",
    });
  });
});
