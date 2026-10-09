import { describe, expect, it, vi } from "vitest";
import { coalesceWithinTick } from "./coalesceWithinTick";

describe("coalesceWithinTick", () => {
  it("runs once for any number of calls in the same tick", async () => {
    const fn = vi.fn();
    const coalesced = coalesceWithinTick(fn);

    coalesced("a");
    coalesced("b");
    coalesced("c");
    expect(fn).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("runs again for a call in a later tick", async () => {
    const fn = vi.fn();
    const coalesced = coalesceWithinTick(fn);

    coalesced("a");
    await Promise.resolve();
    coalesced("b");
    await Promise.resolve();

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
