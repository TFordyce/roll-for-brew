import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { transitionDiceReveal, useDiceReveal } from "./useDiceReveal";

describe("dice reveal state machine (issue #602)", () => {
  it("lands the die on the delivered value when the reveal resolves", () => {
    expect(
      transitionDiceReveal({ phase: "idle" }, { type: "rollResolved", value: 17 }, false),
    ).toEqual({ phase: "landed", value: 17, entrance: "landing" });
  });

  it("lands the die statically when reduced motion is preferred", () => {
    expect(
      transitionDiceReveal({ phase: "idle" }, { type: "rollResolved", value: 4 }, true),
    ).toEqual({ phase: "landed", value: 4, entrance: "static" });
  });

  it("dismisses the landed die on click", () => {
    const landed = transitionDiceReveal({ phase: "idle" }, { type: "rollResolved", value: 17 }, false);

    expect(transitionDiceReveal(landed, { type: "dismiss" }, false)).toEqual({ phase: "dismissed" });
  });

  it("keeps the die dismissed when the reveal delivers the roll again", () => {
    const dismissed = transitionDiceReveal(
      transitionDiceReveal({ phase: "idle" }, { type: "rollResolved", value: 17 }, false),
      { type: "dismiss" },
      false,
    );

    expect(
      transitionDiceReveal(dismissed, { type: "rollResolved", value: 17 }, false),
    ).toEqual({ phase: "dismissed" });
  });

  it("ignores dismissal when no die is shown", () => {
    expect(transitionDiceReveal({ phase: "idle" }, { type: "dismiss" }, false)).toEqual({ phase: "idle" });
  });

  it("starts rolling when the in-app roll is submitted", () => {
    expect(transitionDiceReveal({ phase: "idle" }, { type: "rollSubmitted" }, false)).toEqual({
      phase: "rolling",
    });
  });

  it("keeps rolling when the roll is submitted again", () => {
    expect(transitionDiceReveal({ phase: "rolling" }, { type: "rollSubmitted" }, false)).toEqual({
      phase: "rolling",
    });
  });

  it("lands the die on the delivered value from rolling", () => {
    expect(
      transitionDiceReveal({ phase: "rolling" }, { type: "rollResolved", value: 9 }, false),
    ).toEqual({ phase: "landed", value: 9, entrance: "landing" });
  });

  it("stays landed when the reveal delivers the roll again", () => {
    const landed = transitionDiceReveal({ phase: "idle" }, { type: "rollResolved", value: 17 }, false);

    expect(transitionDiceReveal(landed, { type: "rollResolved", value: 17 }, false)).toEqual({
      phase: "landed",
      value: 17,
      entrance: "landing",
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
