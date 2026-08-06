import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { listRecentRounds } from "@/lib/supabase/adminRounds";
import { CardFrame } from "@/app/_components/CardFrame";
import { DeleteRoundRow } from "@/app/admin/rounds/DeleteRoundRow";

/**
 * `/admin/rounds` (issue #189): lets an admin hard-delete a single round
 * that's left the app in a bad state — e.g. a player turned out not to be
 * whitelisted partway through a round, so it had to be resolved by hand
 * outside the app, leaving bogus rolls/participants behind that stats would
 * otherwise keep counting. Gated the same way as /admin/cards —
 * canAccessTestRoom (is_admin + the Admin Mode cookie).
 */
export default async function AdminRoundsPage() {
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

  const rounds = await listRecentRounds(supabase);

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Delete Round
      </h1>

      <section className="w-full max-w-3xl">
        <CardFrame title={`Recent rounds (${rounds.length})`}>
          {rounds.length === 0 ? (
            <p className="font-body text-sm text-parchment-dim">No rounds yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gilt-dark font-display text-[10px] uppercase tracking-widest text-parchment-dim">
                    <th className="pb-2 pr-3">Room</th>
                    <th className="pb-2 pr-3">Status</th>
                    <th className="pb-2 pr-3">Started by</th>
                    <th className="pb-2 pr-3">Brewer</th>
                    <th className="pb-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rounds.map((round) => (
                    <DeleteRoundRow key={round.id} round={round} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
