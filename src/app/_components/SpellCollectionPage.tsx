import type { SpellCollectionCard as SpellCollectionCardData } from "@/lib/supabase/spellCards";
import { CardFrame } from "@/app/_components/CardFrame";
import { CompletionGauge } from "@/app/_components/CompletionGauge";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { SpellCollectionGrid } from "@/app/_components/SpellCollectionGrid";
import { Nav } from "@/app/Nav";

/**
 * Shared page shell for both `/collection` (own collection, issue #134) and
 * `/collection/:playerId` (any player's, issue #135) — the two routes fetch
 * `get_player_spell_collection` for different target ids and share this one
 * rendering. `viewerPlayerId` always seeds the backdrop's daily prop shuffle
 * off the signed-in viewer (not the collection being looked at), so the
 * background doesn't change depending on whose collection you're viewing.
 */
export function SpellCollectionPage({
  viewerPlayerId,
  heading,
  cards,
}: {
  viewerPlayerId: string;
  heading: string;
  cards: SpellCollectionCardData[];
}) {
  const discoveredCount = cards.filter((c) => c.drawCount > 0).length;

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <ParallaxBackdrop playerId={viewerPlayerId} />
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>
      <Nav active="collection" />

      <section className="w-full max-w-2xl">
        <CardFrame
          title={
            <div className="flex items-center justify-between normal-case tracking-normal">
              <span className="font-display text-sm font-semibold uppercase tracking-widest text-gilt-bright">
                {heading}
              </span>
              <CompletionGauge discovered={discoveredCount} total={cards.length} />
            </div>
          }
        >
          <SpellCollectionGrid cards={cards} />
        </CardFrame>
      </section>
    </main>
  );
}
