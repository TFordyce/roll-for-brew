// The pixel-art backdrop scene: a fixed 1376x768 image pinned to the bottom
// centre of the viewport and scaled so its full width always fits. Anything
// that has to line up with the art derives its geometry from here rather than
// hard-coding pixel positions of its own.

export const SCENE_WIDTH = 1376;
export const SCENE_HEIGHT = 768;

export type ViewportSize = { readonly width: number; readonly height: number };

export function computeSceneScale(containerWidth: number): number {
  if (containerWidth <= 0) return 1;
  return containerWidth / SCENE_WIDTH;
}

// The strip of viewport the scene actually paints. Its full width always fits,
// so on narrow screens it shrinks with the viewport; on wide ones the scaled
// scene is taller than the viewport and is clipped to it.
export function sceneVisibleHeight(viewport: ViewportSize): number {
  if (viewport.height <= 0) return 0;
  const painted = SCENE_HEIGHT * computeSceneScale(viewport.width);
  return Math.min(painted, viewport.height);
}
