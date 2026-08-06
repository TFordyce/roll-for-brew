import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { listRecentModifierAdjustments } from "@/lib/supabase/modifierAdjustments";
import { CardFrame } from "@/app/_components/CardFrame";
import { DeleteAdjustmentRow } from "@/app/admin/adjustments/DeleteAdjustmentRow";

/**
 * `/admin/adjustments` (issue #191): lets an admin delete any modifier
 * adjustment, unrestricted by the actor/most-recent/5-minute limits the
 * self-serve undo (delete_modifier_adjustment, 0052) enforces -- e.g. an
 * adjustment logged by someone else, or noticed well after the fact. Gated
 * the same way as /admin/rounds and /admin/cards -- canAccessTestRoom
 * (is_admin + the Admin Mode cookie).
 */
export default async function AdminAdjustmentsPage() {
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

  const adjustments = await listRecentModifierAdjustments(supabase);

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Delete Modifier Adjustment
      </h1>

      <section className="w-full max-w-4xl">
        <CardFrame title={`Recent adjustments (${adjustments.length})`}>
          {adjustments.length === 0 ? (
            <p className="font-body text-sm text-parchment-dim">No adjustments yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gilt-dark font-display text-[10px] uppercase tracking-widest text-parchment-dim">
                    <th className="pb-2 pr-3">Room</th>
                    <th className="pb-2 pr-3">Target</th>
                    <th className="pb-2 pr-3">Delta</th>
                    <th className="pb-2 pr-3">Reason</th>
                    <th className="pb-2 pr-3">Logged by</th>
                    <th className="pb-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((adjustment) => (
                    <DeleteAdjustmentRow key={adjustment.id} adjustment={adjustment} />
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
