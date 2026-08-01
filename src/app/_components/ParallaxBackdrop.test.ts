import { describe, expect, it } from "vitest";
import { computeSceneScale } from "./ParallaxBackdrop";

const SCENE_WIDTH = 1376;

describe("computeSceneScale", () => {
  it("scales purely off container width, so the full scene width always fits", () => {
    // A height-inclusive "cover" scale (the pre-#95-fix behavior) would pick
    // a much larger factor here to also cover the tall viewport, cropping
    // most of the scene's width away and hiding every prop slot with it.
    const portraitPhone = { width: 375, height: 812 };
    const scale = computeSceneScale(portraitPhone.width);

    expect(scale).toBeCloseTo(portraitPhone.width / SCENE_WIDTH);
    expect(scale * SCENE_WIDTH).toBeCloseTo(portraitPhone.width);
  });

  it("is unaffected by container height", () => {
    const shortAndWide = computeSceneScale(1200);
    const tallAndNarrow = computeSceneScale(1200);
    expect(shortAndWide).toBe(tallAndNarrow);
  });

  it("falls back to 1 for a not-yet-measured (zero-width) container", () => {
    expect(computeSceneScale(0)).toBe(1);
  });
});
