import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin, getRealPlayers } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { CardFrame } from "@/app/_components/CardFrame";
import { BackfillRoundForm } from "@/app/admin/backfill/BackfillRoundForm";

/**
 * `/admin/backfill` (issue #274): lets an admin bulk-record an entire round
 * that happened with physical dice but that nobody ever opened the app for
 * — distinct from Proxy Roll (#273), which folds one absent player into an
 * already-live round. Gated the same way as every other admin tool —
 * canAccessTestRoom (is_admin + the Admin Mode cookie).
 */
export default async function AdminBackfillPage() {
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

  const players = await getRealPlayers(supabase);

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Round Backfill
      </h1>

      <section className="w-full max-w-2xl">
        <CardFrame title="Bulk-record a missed round">
          <p className="mb-4 font-body text-sm text-parchment-dim">
            Use this only when a whole round happened with physical dice and nobody opened the app for it — same-day
            only. For a single player missing from an otherwise-live round, use Proxy Roll instead.
          </p>
          <BackfillRoundForm players={players} />
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
