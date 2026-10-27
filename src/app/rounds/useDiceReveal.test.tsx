import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { initialDiceRevealState, transitionDiceReveal, useDiceReveal } from "./useDiceReveal";

describe("dice reveal state machine (issue #603)", () => {
  it("walks the full lifecycle from submit through landing to dismissal", () => {
    const rolling = transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false);
    const landed = transitionDiceReveal(rolling, { type: "rollResolved", value: 11 }, false);
    const dismissed = transitionDiceReveal(landed, { type: "dismiss" }, false);

    expect(rolling).toEqual({ phase: "rolling" });
    expect(landed).toEqual({ phase: "landed", value: 11, entrance: "landing" });
    expect(dismissed).toEqual({ phase: "dismissed" });
  });

  it("walks the full lifecycle with a static landing under reduced motion", () => {
    const rolling = transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, true);
    const landed = transitionDiceReveal(rolling, { type: "rollResolved", value: 11 }, true);
    const dismissed = transitionDiceReveal(landed, { type: "dismiss" }, true);

    expect(rolling).toEqual({ phase: "rolling" });
    expect(landed).toEqual({ phase: "landed", value: 11, entrance: "static" });
    expect(dismissed).toEqual({ phase: "dismissed" });
  });

  it("lands the die statically when reduced motion is preferred", () => {
    const rolling = transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, true);

    expect(transitionDiceReveal(rolling, { type: "rollResolved", value: 4 }, true)).toEqual({
      phase: "landed",
      value: 4,
      entrance: "static",
    });
  });

  it("holds the tumble indefinitely until the reveal delivers, absorbing events in between", () => {
    let state = transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false);
    for (let waited = 0; waited < 1000; waited += 1) {
      state = transitionDiceReveal(state, { type: "rollSubmitted" }, false);
      state = transitionDiceReveal(state, { type: "dismiss" }, false);
    }

    expect(state).toEqual({ phase: "rolling" });
    expect(transitionDiceReveal(state, { type: "rollResolved", value: 3 }, false)).toEqual({
      phase: "landed",
      value: 3,
      entrance: "landing",
    });
  });

  it("absorbs the resolve when no tumble is in flight (manual and out-of-scope rolls)", () => {
    expect(
      transitionDiceReveal(initialDiceRevealState, { type: "rollResolved", value: 17 }, false),
    ).toEqual({ phase: "idle" });
  });

  it("absorbs the resolve under reduced motion when no tumble is in flight", () => {
    expect(
      transitionDiceReveal(initialDiceRevealState, { type: "rollResolved", value: 17 }, true),
    ).toEqual({ phase: "idle" });
  });

  it("does not restart the tumble from a stray submit once landed", () => {
    const landed = transitionDiceReveal(
      transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false),
      { type: "rollResolved", value: 17 },
      false,
    );

    expect(transitionDiceReveal(landed, { type: "rollSubmitted" }, false)).toEqual({
      phase: "landed",
      value: 17,
      entrance: "landing",
    });
  });

  it("keeps the first landed value when the reveal delivers again", () => {
    const landed = transitionDiceReveal(
      transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false),
      { type: "rollResolved", value: 17 },
      false,
    );

    expect(transitionDiceReveal(landed, { type: "rollResolved", value: 5 }, false)).toEqual({
      phase: "landed",
      value: 17,
      entrance: "landing",
    });
  });

  it("keeps the die dismissed when the reveal delivers the roll again", () => {
    const dismissed = transitionDiceReveal(
      transitionDiceReveal(
        transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false),
        { type: "rollResolved", value: 17 },
        false,
      ),
      { type: "dismiss" },
      false,
    );

    expect(transitionDiceReveal(dismissed, { type: "rollResolved", value: 17 }, false)).toEqual({
      phase: "dismissed",
    });
  });

  it("ignores dismissal when no die is shown", () => {
    expect(transitionDiceReveal(initialDiceRevealState, { type: "dismiss" }, false)).toEqual({
      phase: "idle",
    });
    expect(transitionDiceReveal({ phase: "rolling" }, { type: "dismiss" }, false)).toEqual({
      phase: "rolling",
    });
  });
});

function Probe() {
  const die = useDiceReveal("round-1");
  return <>{die.state.phase}</>;
}

describe("useDiceReveal (server render)", () => {
  it("starts idle before any client effect runs", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("idle");
  });
});
