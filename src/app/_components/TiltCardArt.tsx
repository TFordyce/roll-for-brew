"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";

/** Shared with `HeldCardThumbnail`'s docked thumbnail so the tilt feel is identical. */
export const MAX_TILT_DEG = 16;

/**
 * The 3D pointer-tracking tilt lifted out of `HeldCardThumbnail` (issue #266)
 * so every modal that shows a single card's art gets the same treatment:
 * the `CardInspectModal` consumers `HeldCardThumbnail` and
 * `SpellCollectionGrid`.
 *
 * Renders the standard `aspect-[3/4]` art frame + cover image and rotates it
 * toward the cursor. Gated on `(hover: hover) and (pointer: fine)` — touch
 * devices get a plain static frame, same as the thumbnail.
 */
export function TiltCardArt({
  artPath,
  artClassName = "",
  className = "",
}: {
  artPath: string;
  artClassName?: string;
  className?: string;
}) {
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0 });
  const canTiltRef = useRef(false);

  useEffect(() => {
    canTiltRef.current = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }, []);

  function handleMouseMove(event: MouseEvent<HTMLDivElement>) {
    if (!canTiltRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    setTilt({ rotateX: -dy * MAX_TILT_DEG, rotateY: dx * MAX_TILT_DEG });
  }

  function handleMouseLeave() {
    setTilt({ rotateX: 0, rotateY: 0 });
  }

  return (
    <div
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ transform: `perspective(600px) rotateX(${tilt.rotateX}deg) rotateY(${tilt.rotateY}deg)` }}
      className={`aspect-[3/4] w-full overflow-hidden rounded-md bg-tavern-plank-dark transition-transform duration-150 ease-out ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={artPath} alt="" className={`h-full w-full object-cover ${artClassName}`} />
    </div>
  );
}
