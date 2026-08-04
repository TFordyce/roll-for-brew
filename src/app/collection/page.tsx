import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { getPlayerSpellCollection } from "@/lib/supabase/spellCards";
import { CardFrame } from "@/app/_components/CardFrame";
import { CompletionGauge } from "@/app/_components/CompletionGauge";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { SpellCollectionGrid } from "@/app/_components/SpellCollectionGrid";

/**
 * `/collection` — a signed-in player's own spell collection (issue #134,
 * part of the Spell Collection page spec #130), rendered entirely from the
 * `get_player_spell_collection` RPC (#133): every catalog card left-joined
 * against this player's own draw counts, so a zero-draws player still gets
 * a full (all-undiscovered) grid rather than an empty page. Cross-player
 * viewing, the nav tab, and the /stats teaser are #135's scope, not this
 * page's.
 */
export default async function CollectionPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const playerId = googlePlayerId(user);
  const cards = await getPlayerSpellCollection(supabase, playerId);
  const discoveredCount = cards.filter((c) => c.drawCount > 0).length;

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <ParallaxBackdrop playerId={playerId} />
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>

      <section className="w-full max-w-2xl">
        <CardFrame
          title={
            <div className="flex items-center justify-between normal-case tracking-normal">
              <span className="font-display text-sm font-semibold uppercase tracking-widest text-gilt-bright">
                Spell Collection
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
