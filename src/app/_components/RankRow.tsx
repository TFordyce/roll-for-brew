import type { ReactNode } from "react";

/**
 * A single ranked-list row — rank, avatar, name, stat value — for the
 * tabletop design system's dense leaderboard/history lists (issue #79).
 * Sits alongside `PlayerTile`: that component suits a roster grid of square
 * tiles, this one suits a tall list of many rows (a leaderboard, or a
 * per-room round history) where a tile grid would be too tall on mobile.
 * `rank` is omitted for rows that aren't a ranking (e.g. history rounds).
 */
export function RankRow({
  rank,
  displayName,
  email,
  avatarUrl,
  value,
}: {
  rank?: number;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  value: ReactNode;
}) {
  const name = displayName ?? email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="flex items-center gap-3 py-2">
      {rank !== undefined ? (
        <span className="w-5 shrink-0 font-display text-sm text-gilt">{rank}</span>
      ) : null}
      <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-gilt-dark bg-tavern-plank">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="font-display text-xs font-semibold text-gilt-bright">{initial}</span>
        )}
      </div>
      <span className="flex-1 truncate text-sm text-parchment">{name}</span>
      <span className="shrink-0 font-mono text-sm text-parchment-dim">{value}</span>
    </div>
  );
}
