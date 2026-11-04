"use client";

import { useEffect, useState } from "react";
import type { DiceTableLayout, DiceTableSlot } from "@/lib/game/diceTable";
import { deriveThrowTrack } from "@/lib/game/diceSeeds";
import { useReducedMotion } from "@/lib/hooks/useReducedMotion";
import { type LiveDieState } from "./useDiceReveal";
import { AnimatedDie } from "./AnimatedDie";
import { DIE_SIZE_PX, DieFaces } from "./DieFaces";

// One revealed layer-0 roll, as this client should show it.
export type SharedDie = {
  readonly playerId: string;
  readonly value: number;
  /** True while this client still owes the throw; false once it has played. */
  readonly owesThrow: boolean;
};

// The round's dice, resting on the pixel-art scene's plank.
//
// Every revealed layer-0 roll gets the same derived throw on every client
// (#607) — the roller's own die is simply the one that may also land early.
// The table is pointer-transparent so it never blocks the room, and only the
// viewer's own die takes clicks.
export function DiceTable({
  layout,
  roundId,
  selfPlayerId,
  selfDie,
  sharedDice,
  onDismiss,
}: {
  layout: DiceTableLayout;
  roundId: string;
  selfPlayerId: string;
  /** The viewer's own die, when it is landing early rather than with the reveal. */
  selfDie: LiveDieState | null;
  sharedDice: readonly SharedDie[];
  onDismiss: () => void;
}) {
  const slotByPlayerId = new Map(layout.slots.map((slot) => [slot.playerId, slot]));

  const selfSlot = selfDie ? slotByPlayerId.get(selfPlayerId) : undefined;
  const selfTrack = selfDie ? deriveThrowTrack(roundId, 0, selfPlayerId) : null;

  const shared = sharedDice
    .filter((die) => !(selfDie && die.playerId === selfPlayerId))
    .map((die) => ({ die, slot: slotByPlayerId.get(die.playerId) }))
    .filter((entry): entry is { die: SharedDie; slot: DiceTableSlot } => entry.slot !== undefined);

  if (!selfSlot && shared.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
      {shared.map(({ die, slot }) => {
        // A manual or proxy roll never starts the viewer's controller, so the
        // viewer's own die arrives through the shared batch — it must still be
        // the one die that can be dismissed.
        const isSelf = die.playerId === selfPlayerId;
        return (
          <Slot key={die.playerId} slot={slot} layout={layout}>
            {die.owesThrow ? (
              <SharedDiePlayback
                roundId={roundId}
                playerId={die.playerId}
                value={die.value}
                interactive={isSelf}
                onDismiss={isSelf ? onDismiss : undefined}
              />
            ) : (
              <SettledDie value={die.value} />
            )}
          </Slot>
        );
      })}

      {selfSlot && selfDie && selfTrack ? (
        <Slot slot={selfSlot} layout={layout}>
          <span className="pointer-events-auto block">
            <AnimatedDie state={selfDie} track={selfTrack} onDismiss={onDismiss} />
          </span>
        </Slot>
      ) : null}
    </div>
  );
}

function Slot({
  slot,
  layout,
  children,
}: {
  slot: DiceTableSlot;
  layout: DiceTableLayout;
  children: React.ReactNode;
}) {
  const scale = layout.dieSizePx / DIE_SIZE_PX;

  return (
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
        className="block origin-top-left"
        style={{
          width: DIE_SIZE_PX,
          height: DIE_SIZE_PX,
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </span>
    </div>
  );
}

// A die that owes the viewer its throw: it mounts with the whole batch, plays
// its derived track, then settles onto the value. Reduced-motion clients skip
// straight to the settled face at the same moment.
function SharedDiePlayback({
  roundId,
  playerId,
  value,
  interactive,
  onDismiss,
}: {
  roundId: string;
  playerId: string;
  value: number;
  interactive: boolean;
  onDismiss?: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const track = deriveThrowTrack(roundId, 0, playerId);
  const [landed, setLanded] = useState(false);

  useEffect(() => {
    // Nothing is animating to wait for; go straight to the settled face.
    if (reducedMotion) return;
    const timer = setTimeout(() => setLanded(true), track.durationMs);
    return () => clearTimeout(timer);
  }, [track, reducedMotion]);

  const settled = reducedMotion || landed;

  return (
    <AnimatedDie
      state={settled ? { phase: "landed", value, entrance: "landing" } : { phase: "rolling" }}
      track={track}
      interactive={interactive}
      onDismiss={onDismiss}
    />
  );
}

function SettledDie({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="relative block [perspective:220px]"
      style={{ width: DIE_SIZE_PX, height: DIE_SIZE_PX }}
    >
      <span className="absolute inset-0 block [transform-style:preserve-3d]">
        <DieFaces value={value} />
      </span>
    </span>
  );
}
