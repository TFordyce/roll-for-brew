import { describe, expect, it } from "vitest";
import { buildRerollChain } from "./rerollChain";
import type { CompletedLayer } from "@/lib/supabase/rolls";

const roll = (playerId: string, value: number, modifierSnapshot = 0) => ({
  playerId,
  value,
  modifierSnapshot,
  discardedValue: null,
  enteredByAdmin: false,
});

describe("buildRerollChain", () => {
  it("returns an empty chain for a player who resolved outright at layer 0", () => {
    const history: CompletedLayer[] = [
      { layer: 0, rolls: [roll("a", 15), roll("b", 8, 1), roll("c", 12)] },
    ];

    expect(buildRerollChain("b", history)).toEqual([]);
  });

  it("returns an empty chain for a player not present in the history at all", () => {
    const history: CompletedLayer[] = [{ layer: 0, rolls: [roll("a", 15), roll("b", 8)] }];

    expect(buildRerollChain("nobody", history)).toEqual([]);
  });

  it("builds one resolved level for a tie that broke on the first reroll", () => {
    const history: CompletedLayer[] = [
      { layer: 0, rolls: [roll("a", 15), roll("b", 7, 3), roll("c", 4, 6)] }, // b/c tie on 10
      { layer: 1, rolls: [roll("b", 9, 3), roll("c", 1, 6)] }, // c nat-1s, resolved
    ];

    expect(buildRerollChain("b", history)).toEqual([{ layer: 1, roll: 9, modifier: 3, tied: false }]);
    expect(buildRerollChain("c", history)).toEqual([{ layer: 1, roll: 1, modifier: 6, tied: false }]);
    expect(buildRerollChain("a", history)).toEqual([]);
  });

  it("chains multiple tied levels until the reroll finally resolves", () => {
    const history: CompletedLayer[] = [
      { layer: 0, rolls: [roll("a", 15), roll("b", 7, 3), roll("c", 4, 6)] }, // tie on 10
      { layer: 1, rolls: [roll("b", 5, 3), roll("c", 2, 6)] }, // tie again on 8
      { layer: 2, rolls: [roll("b", 9, 3), roll("c", 1, 6)] }, // c nat-1s, resolved
    ];

    expect(buildRerollChain("b", history)).toEqual([
      { layer: 1, roll: 5, modifier: 3, tied: true },
      { layer: 2, roll: 9, modifier: 3, tied: false },
    ]);
    expect(buildRerollChain("c", history)).toEqual([
      { layer: 1, roll: 2, modifier: 6, tied: true },
      { layer: 2, roll: 1, modifier: 6, tied: false },
    ]);
  });

  it("stops the walk once history runs out of a still-tied level's next layer", () => {
    const history: CompletedLayer[] = [
      { layer: 0, rolls: [roll("a", 15), roll("b", 7, 3), roll("c", 4, 6)] }, // tie on 10
      { layer: 1, rolls: [roll("b", 5, 3), roll("c", 2, 6)] }, // tie again on 8 — layer 2 not revealed yet
    ];

    expect(buildRerollChain("b", history)).toEqual([{ layer: 1, roll: 5, modifier: 3, tied: true }]);
  });
});
