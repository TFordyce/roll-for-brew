"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { MOCK_PLAYERS } from "./mockData";

/**
 * PROTOTYPE-ONLY entry-point chrome (ticket #124), shared by every variant
 * — the routing/navigation question doesn't vary per layout, so it isn't
 * duplicated three times. Demonstrates the settled shape with one throwaway
 * route standing in for two real ones: `/collection` (viewer's own) vs
 * `/collection/:playerId` (someone else's) become `?player=self` /
 * `?player=<id>` here, swapping which mock player's data the grid renders.
 */

function setPlayerParam(
  router: ReturnType<typeof useRouter>,
  searchParams: ReturnType<typeof useSearchParams>,
  playerId: string,
) {
  const params = new URLSearchParams(searchParams.toString());
  params.set("player", playerId);
  router.replace(`?${params.toString()}`);
}

export function PrototypeNav({ activePlayerId }: { activePlayerId: string }) {
  const isSelf = activePlayerId === "self";
  const tabClass = (isActive: boolean) =>
    `rounded-md px-4 py-2.5 font-display text-xs uppercase tracking-widest transition-colors ${
      isActive
        ? "bg-ember text-parchment shadow-[0_0_0_1px_theme(colors.gilt.dark)]"
        : "text-parchment-dim hover:bg-tavern-plank hover:text-parchment"
    }`;
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <nav className="flex gap-1 rounded-lg border-4 border-gilt bg-tavern-panel p-1 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.5)]">
      <span className={tabClass(false)}>Room</span>
      <span className={tabClass(false)}>Stats</span>
      <button type="button" onClick={() => setPlayerParam(router, searchParams, "self")} className={tabClass(isSelf)}>
        Collection
      </button>
    </nav>
  );
}

/** Stands in for a teaser CardFrame section dropped into the real /stats page. */
export function StatsTeaser({
  discovered,
  total,
  onOpen,
}: {
  discovered: number;
  total: number;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-lg border-4 border-gilt bg-tavern-panel p-4 shadow-[0_0_0_1px_theme(colors.gilt.dark)]">
      <h2 className="mb-2 font-display text-sm font-semibold uppercase tracking-widest text-gilt-bright">
        Spell Collection
      </h2>
      <div className="flex items-center justify-between">
        <p className="font-mono text-sm text-parchment">
          {discovered}/{total} discovered
        </p>
        <button
          type="button"
          onClick={onOpen}
          className="rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
        >
          View collection →
        </button>
      </div>
    </div>
  );
}

/** Stands in for RankRow-style rows elsewhere (roster/leaderboard) whose names link out to a collection. */
export function RosterTapDemo({ activePlayerId }: { activePlayerId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <div className="rounded-lg border-4 border-gilt bg-tavern-panel p-4 shadow-[0_0_0_1px_theme(colors.gilt.dark)]">
      <h2 className="mb-2 font-display text-xs font-semibold uppercase tracking-widest text-gilt-bright">
        Roster (tap a name → their collection)
      </h2>
      <div className="divide-y divide-gilt-dark/40">
        {MOCK_PLAYERS.map((p) => (
          <button
            key={p.playerId}
            type="button"
            onClick={() => setPlayerParam(router, searchParams, p.playerId)}
            className={`block w-full py-2 text-left text-sm hover:text-gilt-bright ${
              activePlayerId === p.playerId ? "text-gilt-bright" : "text-parchment"
            }`}
          >
            {p.displayName}
            {p.isSelf ? " (you)" : ""}
          </button>
        ))}
      </div>
      <p className="mt-2 font-mono text-[10px] text-parchment-dim">
        Real routing: /collection (self) — /collection/:playerId (others). This prototype uses ?player= on one
        route to demo both without a real dynamic segment.
      </p>
    </div>
  );
}
