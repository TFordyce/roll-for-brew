import Link from "next/link";
import type { ReactNode } from "react";

export function RankRow({
  rank,
  displayName,
  email,
  avatarUrl,
  value,
  playerId,
}: {
  rank?: number;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  value: ReactNode;
  playerId?: string;
}) {
  const name = displayName ?? email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  const row = (
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

  if (!playerId) {
    return row;
  }

  return (
    <Link href={`/${playerId}`} className="-mx-1 block rounded-md px-1 transition-colors hover:bg-tavern-plank/40">
      {row}
    </Link>
  );
}
