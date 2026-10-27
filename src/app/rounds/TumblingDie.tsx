"use client";

import { DIE_SIZE_PX, DieFaces } from "./LandedDie";

export function TumblingDie() {
  return (
    <span
      aria-hidden="true"
      className="relative block shrink-0 [perspective:220px]"
      style={{ width: DIE_SIZE_PX, height: DIE_SIZE_PX }}
    >
      <span className="absolute inset-0 block [transform-style:preserve-3d] animate-die-tumble motion-reduce:animate-none">
        <DieFaces />
      </span>
    </span>
  );
}
