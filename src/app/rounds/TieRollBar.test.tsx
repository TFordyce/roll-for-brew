import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/rounds/RollInputPicker", () => ({
  RollInputPicker: () => <div>ROLL_PICKER</div>,
}));

const { TieRollBar } = await import("./TieRollBar");

// Issue #592: the tie prompt used to be a full-screen overlay with no
// dismiss — the page was dead while waiting for the other tied player, and
// an admin rolling for both sides could not reach anything. It is a bottom
// bar now: visible, never blocking.
describe("TieRollBar (issue #592)", () => {
  const base = { roundId: "r1", otherTiedNames: ["Test 2"] };

  it("waiting on the other player never renders a blocking overlay", () => {
    const html = renderToStaticMarkup(<TieRollBar {...base} ownRoll={12} rollInputMode={null} />);
    expect(html).toContain("Rolled!");
    expect(html).toContain("Waiting for Test 2");
    expect(html).not.toContain("fixed inset-0");
    expect(html).not.toContain('role="dialog"');
  });

  it("a tied player yet to roll sees the prompt and the roll picker in the bar", () => {
    const html = renderToStaticMarkup(
      <TieRollBar {...base} ownRoll={null} rollInputMode="in_app_only" />,
    );
    expect(html).toContain("Tied!");
    expect(html).toContain("Roll again to break the tie");
    expect(html).toContain("ROLL_PICKER");
    expect(html).not.toContain("fixed inset-0");
  });
});
