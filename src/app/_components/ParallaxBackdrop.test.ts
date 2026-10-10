import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeSceneScale, PROP_ASPECT, PROP_IMAGES } from "./ParallaxBackdrop";

const SCENE_WIDTH = 1376;

function pngSize(publicPath: string) {
  const file = readFileSync(path.join(process.cwd(), "public", publicPath));
  expect(file.slice(12, 16).toString("ascii")).toBe("IHDR");
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

describe("computeSceneScale", () => {
  it("scales purely off container width, so the full scene width always fits", () => {
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

describe("backdrop assets", () => {
  it.each(Object.entries(PROP_IMAGES))(
    "PROP_ASPECT[%s] matches the served PNG dimensions",
    (key, publicPath) => {
      const { width, height } = pngSize(publicPath);
      expect(PROP_ASPECT[key as keyof typeof PROP_ASPECT]).toBeCloseTo(width / height, 10);
    },
  );

  it("all steam frames share one uniform canvas size", () => {
    const sizes = [1, 2, 3, 4, 5].map((n) => pngSize(`/backdrop/steam/steam-${n}.png`));
    for (const size of sizes) {
      expect(size).toEqual(sizes[0]);
    }
  });
});
