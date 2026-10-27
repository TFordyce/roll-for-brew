"use client";

import type { DiceRevealEntrance } from "./useDiceReveal";
import { DIE_SIZE_PX, DieFaces } from "./DieFaces";

export function LandedDie({
  value,
  entrance,
  onDismiss,
}: {
  value: number;
  entrance: DiceRevealEntrance;
  onDismiss: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onDismiss();
      }}
      title="Back to the roll row"
      aria-label="Back to the roll row"
      className="relative shrink-0 cursor-pointer [perspective:220px]"
      style={{ width: DIE_SIZE_PX, height: DIE_SIZE_PX }}
    >
      <span
        className={`absolute inset-0 block [transform-style:preserve-3d] ${
          entrance === "landing" ? "animate-die-land motion-reduce:animate-none" : ""
        }`}
      >
        <DieFaces value={value} />
      </span>
    </button>
  );
}
