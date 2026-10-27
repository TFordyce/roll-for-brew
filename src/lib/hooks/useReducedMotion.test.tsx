import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { subscribeToPreferredReducedMotion, useReducedMotion } from "./useReducedMotion";

type ChangeListener = (event: { matches: boolean }) => void;

function fakeQuery(matches: boolean) {
  const listeners: ChangeListener[] = [];
  const query = {
    matches,
    addEventListener: vi.fn((_type: "change", listener: ChangeListener) => {
      listeners.push(listener);
    }),
    removeEventListener: vi.fn((_type: "change", listener: ChangeListener) => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    }),
  };
  const emitChange = (nextMatches: boolean) => {
    for (const listener of [...listeners]) listener({ matches: nextMatches });
  };
  return { query, listeners, emitChange };
}

describe("subscribeToPreferredReducedMotion", () => {
  it("reports the query's current preference as soon as it subscribes", () => {
    const { query } = fakeQuery(true);
    const onChange = vi.fn();

    subscribeToPreferredReducedMotion(query, onChange);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("follows change events while subscribed", () => {
    const { query, emitChange } = fakeQuery(false);
    const onChange = vi.fn();

    subscribeToPreferredReducedMotion(query, onChange);
    emitChange(true);
    emitChange(false);

    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("stops following changes once the subscription is cleaned up", () => {
    const { query, emitChange } = fakeQuery(false);
    const onChange = vi.fn();

    const unsubscribe = subscribeToPreferredReducedMotion(query, onChange);
    unsubscribe();
    emitChange(true);

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

function Probe() {
  const reduced = useReducedMotion();
  return <>{reduced ? "reduced" : "motion"}</>;
}

describe("useReducedMotion (server render)", () => {
  it("defaults to full motion before any client effect runs", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("motion");
  });
});
