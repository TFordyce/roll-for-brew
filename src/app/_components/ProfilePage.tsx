import Link from "next/link";
import type { PlayerStatsSnapshot, StatsWindow } from "@/lib/supabase/stats";
import { DRINK_TYPES, type DrinkType, type UsualDrink } from "@/lib/supabase/usualDrinks";
import { Nav } from "@/app/Nav";
import { CardFrame } from "@/app/_components/CardFrame";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { WindowToggle } from "@/app/_components/WindowToggle";

const DRINK_LABELS: Record<DrinkType, string> = { tea: "Tea", coffee: "Coffee" };

/**
 * `/:playerId` profile page shell (issue #212, part of the Brew Rating spec
 * #208) — player header, Usual card, Brew Rating card, Player Stats card,
 * and a link down to the collection route, per the picked "stacked
 * stats-page mirror" layout prototype variant (issue #203). Mirrors
 * `SpellCollectionPage`'s split between the route (auth/data-fetching) and
 * this presentational shell. `viewerPlayerId` seeds the backdrop's daily
 * prop shuffle off the signed-in viewer, same reasoning as
 * `SpellCollectionPage`'s own prop — the background doesn't change
 * depending on whose profile is being viewed.
 *
 * The Usual card is read-only here regardless of whose profile is being
 * viewed — `usual_drinks` is already world-readable (Menu depends on
 * that), so there's no visibility gate to add. Editing only ever happens
 * on Settings' `UsualForm`; this card just links there when
 * `viewerPlayerId === targetPlayerId`, rather than duplicating the
 * milk/sugar picker on a second page.
 */
export function ProfilePage({
  viewerPlayerId,
  targetPlayerId,
  displayName,
  email,
  avatarUrl,
  brewRatingAverage,
  stats,
  window,
  usualDrinks,
}: {
  viewerPlayerId: string;
  targetPlayerId: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  brewRatingAverage: number | null;
  stats: PlayerStatsSnapshot;
  window: StatsWindow;
  usualDrinks: Record<DrinkType, UsualDrink | null>;
}) {
  const name = displayName ?? email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  const statRows: { label: string; value: string | number }[] = [
    { label: "Cups made", value: stats.cupsMade },
    { label: "Rounds lost", value: stats.roundsLost },
    {
      label: "Loss percentage",
      value: `${stats.lossPercentage}% (${stats.roundsLost}/${stats.roundsPlayed})`,
    },
    { label: "Highest modifier reached", value: stats.peakModifier },
  ];

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <ParallaxBackdrop playerId={viewerPlayerId} />
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>
      <Nav active={null} />

      <section className="flex w-full max-w-md items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-gilt bg-tavern-plank">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="font-display text-lg font-semibold text-gilt-bright">{initial}</span>
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-parchment">{name}</p>
          {displayName ? <p className="truncate text-xs text-parchment-dim">{email}</p> : null}
        </div>
      </section>

      <section className="w-full max-w-md">
        <CardFrame
          title={
            <div className="flex items-center justify-between normal-case tracking-normal">
              <span className="font-display text-sm font-semibold uppercase tracking-widest text-gilt-bright">
                Usual
              </span>
              {viewerPlayerId === targetPlayerId ? (
                <Link
                  href="/settings"
                  className="font-display text-xs uppercase tracking-widest text-gilt-bright hover:text-gilt"
                >
                  Edit in Settings →
                </Link>
              ) : null}
            </div>
          }
        >
          <div className="divide-y divide-gilt-dark/40">
            {DRINK_TYPES.map((drinkType) => {
              const usual = usualDrinks[drinkType];
              return (
                <div key={drinkType} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-parchment-dim">{DRINK_LABELS[drinkType]}</span>
                  <span className="font-mono text-parchment">
                    {usual ? `${usual.milk}, ${usual.sugar}${usual.decaf ? " (decaf)" : ""}` : "no preference set"}
                  </span>
                </div>
              );
            })}
          </div>
        </CardFrame>
      </section>

      <section className="w-full max-w-md">
        <CardFrame title="Brew Rating">
          {brewRatingAverage === null ? (
            <p className="text-sm text-parchment-dim">No ratings yet.</p>
          ) : (
            <p className="font-display text-3xl font-semibold text-gilt-bright">
              {brewRatingAverage.toFixed(2)}
            </p>
          )}
        </CardFrame>
      </section>

      <section className="w-full max-w-md">
        <CardFrame
          title={
            <div className="flex items-center justify-between normal-case tracking-normal">
              <span className="font-display text-sm font-semibold uppercase tracking-widest text-gilt-bright">
                Player Stats
              </span>
              <WindowToggle window={window} basePath={`/${targetPlayerId}`} />
            </div>
          }
        >
          <div className="divide-y divide-gilt-dark/40">
            {statRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between py-2 text-sm">
                <span className="text-parchment-dim">{row.label}</span>
                <span className="font-mono text-parchment">{row.value}</span>
              </div>
            ))}
          </div>
        </CardFrame>
      </section>

      <section className="w-full max-w-md">
        <Link
          href={`/${targetPlayerId}/collection`}
          className="flex items-center justify-between rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-4 py-3 text-sm text-parchment transition-colors hover:bg-tavern-panel"
        >
          <span>Spell Collection</span>
          <span className="font-display text-xs uppercase tracking-widest text-gilt-bright">
            View collection →
          </span>
        </Link>
      </section>
    </main>
  );
}
