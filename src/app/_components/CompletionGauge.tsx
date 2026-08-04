"use client";

/**
 * Circular "kettle gauge" completion indicator, promoted from the reviewed
 * Spell Collection prototype (ticket #124, branch
 * worktree-spell-collection-prototype commit 99bec1f) into a shared
 * component for the real page (issue #134, part of spec #130).
 */
export function CompletionGauge({ discovered, total }: { discovered: number; total: number }) {
  const pct = total > 0 ? discovered / total : 0;
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={radius} strokeWidth="6" className="fill-none stroke-tavern-plank-dark" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          strokeWidth="6"
          strokeLinecap="round"
          className="fill-none stroke-gilt-bright"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
        />
      </svg>
      <span className="absolute font-mono text-[10px] text-parchment">
        {discovered}/{total}
      </span>
    </div>
  );
}
