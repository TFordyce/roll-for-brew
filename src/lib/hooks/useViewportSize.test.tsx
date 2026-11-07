import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { subscribeToViewportSize, useViewportSize } from "./useViewportSize";

type Listener = () => void;

function fakeSource(width: number, height: number) {
  const listeners: Record<string, Listener[]> = { resize: [], orientationchange: [] };
  let size = { width, height };
  const source = {
    measure: () => size,
    addEventListener: vi.fn((type: "resize" | "orientationchange", listener: Listener) => {
      listeners[type]!.push(listener);
    }),
    removeEventListener: vi.fn((type: "resize" | "orientationchange", listener: Listener) => {
      const index = listeners[type]!.indexOf(listener);
      if (index !== -1) listeners[type]!.splice(index, 1);
    }),
  };
  const emit = (type: "resize" | "orientationchange") => {
    for (const listener of [...listeners[type]!]) listener();
  };
  const resizeTo = (nextWidth: number, nextHeight: number) => {
    size = { width: nextWidth, height: nextHeight };
  };
  return { source, listeners, emit, resizeTo };
}

describe("subscribeToViewportSize", () => {
  it("reports the current size as soon as it subscribes", () => {
    const { source } = fakeSource(1024, 768);
    const onChange = vi.fn();

    subscribeToViewportSize(source, onChange);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ width: 1024, height: 768 });
  });

  it("reports the new size on resize", () => {
    const { source, emit, resizeTo } = fakeSource(1024, 768);
    const onChange = vi.fn();

    subscribeToViewportSize(source, onChange);
    resizeTo(375, 812);
    emit("resize");

    expect(onChange).toHaveBeenLastCalledWith({ width: 375, height: 812 });
  });

  it("follows a rotation too, since the height flips", () => {
    const { source, emit, resizeTo } = fakeSource(812, 375);
    const onChange = vi.fn();

    subscribeToViewportSize(source, onChange);
    resizeTo(375, 812);
    emit("orientationchange");

    expect(onChange).toHaveBeenLastCalledWith({ width: 375, height: 812 });
  });

  it("stops following changes once the subscription is cleaned up", () => {
    const { source, listeners, emit, resizeTo } = fakeSource(1024, 768);
    const onChange = vi.fn();

    const unsubscribe = subscribeToViewportSize(source, onChange);
    unsubscribe();
    resizeTo(375, 812);
    emit("resize");
    emit("orientationchange");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(listeners.resize).toHaveLength(0);
    expect(listeners.orientationchange).toHaveLength(0);
  });
});

function Probe() {
  const { width, height } = useViewportSize();
  return (
    <>
      {width}x{height}
    </>
  );
}

describe("useViewportSize (server render)", () => {
  it("starts from the conservative phone default before any client effect runs", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("375x667");
  });
});
