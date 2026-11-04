"use client";

import type { DiceTableLayout } from "@/lib/game/diceTable";
import { type LiveDieState } from "./useDiceReveal";
import { AnimatedDie } from "./AnimatedDie";
import { DIE_SIZE_PX } from "./DieFaces";

// The round's dice, resting on the pixel-art scene's plank.
//
// This ticket only moves the viewer's own die here; every other slot is
// reserved but empty until shared playback lands (#607). The table is
// pointer-transparent so it never blocks the room, and only the viewer's own
// die takes clicks.
export function DiceTable({
  layout,
  selfPlayerId,
  selfDie,
  onDismiss,
}: {
  layout: DiceTableLayout;
  selfPlayerId: string;
  selfDie: LiveDieState | null;
  onDismiss: () => void;
}) {
  const slot = selfDie ? layout.slots.find((s) => s.playerId === selfPlayerId) : undefined;
  if (!selfDie || !slot) return null;

  const scale = layout.dieSizePx / DIE_SIZE_PX;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
      <div
        className="absolute"
        style={{
          left: slot.x - layout.dieSizePx / 2,
          top: slot.y - layout.dieSizePx / 2,
          width: layout.dieSizePx,
          height: layout.dieSizePx,
        }}
      >
        <span
          className="pointer-events-auto block origin-top-left"
          style={{
            width: DIE_SIZE_PX,
            height: DIE_SIZE_PX,
            transform: `scale(${scale})`,
          }}
        >
          <AnimatedDie state={selfDie} onDismiss={onDismiss} />
        </span>
      </div>
    </div>
  );
}
