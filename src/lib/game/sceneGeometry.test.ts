import { describe, expect, it } from "vitest";
import { SCENE_HEIGHT, SCENE_WIDTH, computeSceneScale, sceneVisibleHeight } from "./sceneGeometry";

describe("computeSceneScale", () => {
  it("scales purely off container width, so the full scene width always fits", () => {
    const portraitPhone = { width: 375, height: 812 };
    const scale = computeSceneScale(portraitPhone.width);

    expect(scale).toBeCloseTo(portraitPhone.width / SCENE_WIDTH);
    expect(scale * SCENE_WIDTH).toBeCloseTo(portraitPhone.width);
  });

  it("grows linearly with container width", () => {
    expect(computeSceneScale(1200)).toBeGreaterThan(computeSceneScale(800));
    expect(computeSceneScale(1200)).toBeCloseTo(1.5 * computeSceneScale(800));
  });

  it("falls back to 1 for a not-yet-measured (zero-width) container", () => {
    expect(computeSceneScale(0)).toBe(1);
  });
});

describe("sceneVisibleHeight", () => {
  it("shrinks with the viewport on narrow screens", () => {
    const phone = { width: 375, height: 812 };

    expect(sceneVisibleHeight(phone)).toBeCloseTo(SCENE_HEIGHT * (375 / SCENE_WIDTH));
    expect(sceneVisibleHeight(phone)).toBeLessThan(SCENE_HEIGHT);
  });

  it("is the full scene height once the viewport is at least the scene width", () => {
    expect(sceneVisibleHeight({ width: SCENE_WIDTH, height: 900 })).toBeCloseTo(SCENE_HEIGHT);
  });

  it("is clipped to the viewport when the scene is scaled larger than it", () => {
    expect(sceneVisibleHeight({ width: SCENE_WIDTH * 2, height: 1080 })).toBe(1080);
  });

  it("reports nothing before the viewport has been measured", () => {
    expect(sceneVisibleHeight({ width: 0, height: 0 })).toBe(0);
  });
});
