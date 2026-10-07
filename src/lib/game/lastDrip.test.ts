import { describe, expect, it } from "vitest";
import { lastDripNotice } from "@/lib/game/lastDrip";

const NAMES: Record<string, string> = { ben: "Ben", cass: "Cass", dev: "Dev" };
const displayName = (id: string) => NAMES[id] ?? id;

describe("lastDripNotice (issue #470)", () => {
  it("says nothing extra when the previous winner qualifies", () => {
    expect(lastDripNotice({ targetPlayerId: "ben", reason: null, passedOver: [] }, displayName)).toBeNull();
  });

  it("says nothing when the caster isn't holding Last Drip", () => {
    expect(lastDripNotice(null, displayName)).toBeNull();
  });

  it("names the substitute and why, and says it can change", () => {
    expect(
      lastDripNotice(
        { targetPlayerId: "ben", reason: null, passedOver: [{ playerId: "cass", reason: "roll_exempt" }] },
        displayName,
      ),
    ).toBe(
      "Cass is exempt from rolling, so Last Drip would currently name Ben instead. This can change if someone declares in or plays a card later this round.",
    );
  });

  it("warns that the card would currently do nothing when nobody qualifies", () => {
    expect(
      lastDripNotice(
        {
          targetPlayerId: null,
          reason: "no_eligible_roller",
          passedOver: [
            { playerId: "cass", reason: "absent" },
            { playerId: "dev", reason: "roll_exempt" },
          ],
        },
        displayName,
      ),
    ).toBe(
      "Cass isn't in this round and Dev is exempt from rolling, so nobody from the previous round can currently make tea: Last Drip would do nothing. This can change if someone declares in or plays a card later this round.",
    );
  });

  it("warns when there's no previous round", () => {
    expect(
      lastDripNotice({ targetPlayerId: null, reason: "no_previous_round", passedOver: [] }, displayName),
    ).toBe("There's no previous round, so Last Drip would do nothing.");
  });
});
