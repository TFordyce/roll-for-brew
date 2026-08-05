import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin, getRealPlayers } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { getCardAssignments } from "@/lib/supabase/adminCards";
import { CardFrame } from "@/app/_components/CardFrame";
import { CardAssignmentTable } from "@/app/admin/cards/CardAssignmentTable";

/**
 * `/admin/cards` (issue #154): reconciles the app's spell_deck_instances
 * records with who's actually holding which physical card at the table.
 * The 4th-edition deck was in physical play for about a month before the
 * app tracked per-card holding, so most players already hold a card the app
 * doesn't reflect, and new players keep joining mid-edition already holding
 * one IRL — this is a reusable tool for that ongoing reconciliation, not a
 * one-off backfill script.
 *
 * Gated the same way as /admin/test-room — canAccessTestRoom (is_admin +
 * the Admin Mode cookie) — but unlike that room's own admin card tooling
 * (draw_spell_card_as, hard-locked to is_test), this operates on real
 * players/rooms, since the whole point is reconciling real hands.
 */
export default async function AdminCardsPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const { playerId: realPlayerId } = current;
  const isAdmin = await getIsAdmin(supabase, realPlayerId);
  const adminModeEnabled = await getAdminModeEnabled();

  if (!canAccessTestRoom({ isAdmin, adminModeEnabled })) {
    redirect("/");
  }

  const [cards, players] = await Promise.all([getCardAssignments(supabase), getRealPlayers(supabase)]);

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Allocate Spell Cards
      </h1>

      <section className="w-full max-w-3xl">
        <CardFrame title={`Catalog (${cards.length} cards)`}>
          <CardAssignmentTable cards={cards} players={players} />
        </CardFrame>
      </section>

      <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
        <Link href="/admin/test-room" className="text-tavern-panel underline hover:text-ember">
          Back
        </Link>
      </div>
    </main>
  );
}
