import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDiceRevealController,
  initialDiceRevealState,
  transitionDiceReveal,
  useDiceReveal,
  type DiceRevealState,
} from "./useDiceReveal";

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

  it("follows the authoritative broadcast when it delivers an updated value while landed", () => {
    const landed = transitionDiceReveal(
      transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false),
      { type: "rollResolved", value: 17 },
      false,
    );

    expect(transitionDiceReveal(landed, { type: "rollResolved", value: 5 }, false)).toEqual({
      phase: "landed",
      value: 5,
      entrance: "landing",
    });
  });

  it("keeps the landed entrance when the reveal delivers the same value again", () => {
    const landed = transitionDiceReveal(
      transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, true),
      { type: "rollResolved", value: 17 },
      true,
    );

    expect(transitionDiceReveal(landed, { type: "rollResolved", value: 17 }, true)).toEqual({
      phase: "landed",
      value: 17,
      entrance: "static",
    });
  });

  it("yields to the resolver's output when it overrules the landed value", () => {
    const landed = transitionDiceReveal(
      transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false),
      { type: "rollResolved", value: 17 },
      false,
    );

    expect(transitionDiceReveal(landed, { type: "resolverOutputArrived", value: 5 }, false)).toEqual({
      phase: "dismissed",
    });
  });

  it("yields to a disagreeing resolver output under reduced motion too", () => {
    const landed = transitionDiceReveal(
      transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, true),
      { type: "rollResolved", value: 17 },
      true,
    );

    expect(transitionDiceReveal(landed, { type: "resolverOutputArrived", value: 5 }, true)).toEqual({
      phase: "dismissed",
    });
  });

  it("keeps the landed die when the resolver's output agrees with it", () => {
    const landed = transitionDiceReveal(
      transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false),
      { type: "rollResolved", value: 17 },
      false,
    );

    expect(transitionDiceReveal(landed, { type: "resolverOutputArrived", value: 17 }, false)).toEqual({
      phase: "landed",
      value: 17,
      entrance: "landing",
    });
  });

  it("absorbs the resolver's output while the die is still tumbling", () => {
    const rolling = transitionDiceReveal(initialDiceRevealState, { type: "rollSubmitted" }, false);

    expect(transitionDiceReveal(rolling, { type: "resolverOutputArrived", value: 5 }, false)).toEqual({
      phase: "rolling",
    });
  });

  it("absorbs the resolver's output when no die is in flight", () => {
    expect(
      transitionDiceReveal(initialDiceRevealState, { type: "resolverOutputArrived", value: 5 }, false),
    ).toEqual({ phase: "idle" });
    expect(
      transitionDiceReveal({ phase: "dismissed" }, { type: "resolverOutputArrived", value: 5 }, false),
    ).toEqual({ phase: "dismissed" });
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

describe("dice reveal controller (issue #600 testing seam)", () => {
  function startController(options?: { reducedMotion?: boolean }) {
    let reducedMotion = options?.reducedMotion ?? false;
    const states: DiceRevealState[] = [];
    const controller = createDiceRevealController({
      onStateChange: (state) => states.push(state),
      getReducedMotion: () => reducedMotion,
    });
    return {
      controller,
      states,
      setReducedMotion: (next: boolean) => {
        reducedMotion = next;
      },
    };
  }

  it("walks the full lifecycle from submit through landing to dismissal", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollResolved(11);
    controller.dismiss();

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "landed", value: 11, entrance: "landing" },
      { phase: "dismissed" },
    ]);
    expect(controller.getState()).toEqual({ phase: "dismissed" });
  });

  it("lands statically under reduced motion", () => {
    const { controller, states } = startController({ reducedMotion: true });

    controller.rollSubmitted();
    controller.rollResolved(4);

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "landed", value: 4, entrance: "static" },
    ]);
  });

  it("picks up a reduced-motion preference change before the resolve lands", () => {
    const { controller, states, setReducedMotion } = startController();

    controller.rollSubmitted();
    setReducedMotion(true);
    controller.rollResolved(9);

    expect(states[1]).toEqual({ phase: "landed", value: 9, entrance: "static" });
  });

  it("holds the tumble through stray submits and dismissals until the resolve arrives", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollSubmitted();
    controller.dismiss();

    expect(states).toEqual([{ phase: "rolling" }]);

    controller.rollResolved(3);
    expect(states).toEqual([{ phase: "rolling" }, { phase: "landed", value: 3, entrance: "landing" }]);
  });

  it("absorbs a resolve when no tumble is in flight", () => {
    const { controller, states } = startController();

    controller.rollResolved(17);

    expect(states).toEqual([]);
    expect(controller.getState()).toEqual({ phase: "idle" });
  });

  it("does not restart the tumble from a stray submit once landed", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollResolved(17);
    controller.rollSubmitted();

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "landed", value: 17, entrance: "landing" },
    ]);
  });

  it("follows an authoritative broadcast that updates the value while landed", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollResolved(17);
    controller.rollResolved(5);

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "landed", value: 17, entrance: "landing" },
      { phase: "landed", value: 5, entrance: "landing" },
    ]);
  });

  it("does not re-emit when the broadcast repeats the landed value", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollResolved(17);
    controller.rollResolved(17);

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "landed", value: 17, entrance: "landing" },
    ]);
  });

  it("yields to the resolver's output when it overrules the landed value", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollResolved(17);
    controller.resolverOutputArrived(5);

    expect(states[states.length - 1]).toEqual({ phase: "dismissed" });
    expect(controller.getState()).toEqual({ phase: "dismissed" });
  });

  it("keeps the landed die when the resolver's output agrees with it", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollResolved(17);
    controller.resolverOutputArrived(17);

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "landed", value: 17, entrance: "landing" },
    ]);
  });

  it("keeps the die dismissed once the resolver has overruled it", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.rollResolved(17);
    controller.resolverOutputArrived(5);
    controller.rollResolved(17);
    controller.resolverOutputArrived(5);

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "landed", value: 17, entrance: "landing" },
      { phase: "dismissed" },
    ]);
  });

  it("absorbs the resolver's output while tumbling and when idle", () => {
    const { controller, states } = startController();

    controller.resolverOutputArrived(5);
    controller.rollSubmitted();
    controller.resolverOutputArrived(5);

    expect(states).toEqual([{ phase: "rolling" }]);
  });

  it("resets to idle for a new round", () => {
    const { controller, states } = startController();

    controller.rollSubmitted();
    controller.reset();

    expect(states).toEqual([
      { phase: "rolling" },
      { phase: "idle" },
    ]);
    expect(controller.getState()).toEqual({ phase: "idle" });
  });

  it("ignores dismissal when no die is shown", () => {
    const { controller, states } = startController();

    controller.dismiss();
    controller.rollSubmitted();
    controller.dismiss();

    expect(states).toEqual([{ phase: "rolling" }]);
    expect(controller.getState()).toEqual({ phase: "rolling" });
  });
});
