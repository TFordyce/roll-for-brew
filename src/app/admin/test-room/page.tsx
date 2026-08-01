import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { getRoomRoster, getTestRoomId } from "@/lib/supabase/rooms";
import { CardFrame } from "@/app/_components/CardFrame";
import { PlayerTile } from "@/app/_components/PlayerTile";

/**
 * The Test Room (issue #101 / ADR 0002): a real, persistent room row, guarded
 * by canAccessTestRoom so it can only ever be reached by a flagged admin
 * with Admin Mode on — anyone else, or that same admin with the cookie off,
 * is redirected home rather than shown an error, since this route simply
 * doesn't exist for them.
 */
export default async function TestRoomPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const isAdmin = await getIsAdmin(supabase, current.playerId);
  const adminModeEnabled = await getAdminModeEnabled();

  if (!canAccessTestRoom({ isAdmin, adminModeEnabled })) {
    redirect("/");
  }

  const roomId = await getTestRoomId(supabase);
  const roster = roomId ? await getRoomRoster(supabase, roomId) : [];

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Test Room
      </h1>

      <section className="w-full max-w-md">
        <CardFrame title="Test Roster">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
            {roster.map((entry) => (
              <PlayerTile
                key={entry.playerId}
                displayName={entry.displayName}
                email={entry.email}
                avatarUrl={entry.avatarUrl}
                modifier={entry.modifier}
                isTest={entry.isTest}
              />
            ))}
          </div>
        </CardFrame>
      </section>
    </main>
  );
}
