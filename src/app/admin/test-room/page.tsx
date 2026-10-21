import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { getTestRoomId } from "@/lib/supabase/rooms";
import { ActingAsSwitcher, type ActingAsOption } from "@/app/admin/test-room/ActingAsSwitcher";
import { EndTestSessionButton } from "@/app/admin/test-room/EndTestSessionButton";
import { RoomViewProvider } from "@/lib/room/RoomViewProvider";
import { loadInitialRoomView } from "@/lib/room/loadInitialRoomView";
import { RoomScreen } from "@/app/rounds/RoomScreen";

export default async function TestRoomPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const { playerId: realPlayerId, user } = current;

  const isAdmin = await getIsAdmin(supabase, realPlayerId);
  const adminModeEnabled = await getAdminModeEnabled();

  if (!canAccessTestRoom({ isAdmin, adminModeEnabled })) {
    redirect("/");
  }

  const roomId = await getTestRoomId(supabase);

  if (!roomId) {
    return (
      <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
        <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
          Test Room
        </h1>
        <p className="font-body text-sm text-parchment">
          No Test Room has been seeded yet — run the admin/test-room migration first.
        </p>
      </main>
    );
  }

  const initialView = await loadInitialRoomView(supabase, roomId);
  const { data: viewRealPlayer } = await supabase
    .from("players")
    .select("display_name, email")
    .eq("id", realPlayerId)
    .maybeSingle();
  const viewOptions: ActingAsOption[] = [
    {
      playerId: realPlayerId,
      displayName: viewRealPlayer?.display_name ?? null,
      email: viewRealPlayer?.email ?? user.email ?? "",
      isSelf: true,
    },
    ...initialView.room.roster.map((entry) => ({
      playerId: entry.playerId,
      displayName: entry.displayName,
      email: entry.email ?? "",
      isSelf: false,
    })),
  ];
  return (
    <RoomViewProvider roomId={roomId} initialView={initialView}>
      <RoomScreen
        variant="testRoom"
        top={
          <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
            Test Room
          </h1>
        }
        afterTopPanels={
          <section className="w-full max-w-md">
            <ActingAsSwitcher options={viewOptions} currentPlayerId={initialView.viewer.playerId} />
          </section>
        }
        bottom={
          <>
            <section className="w-full max-w-md">
              <EndTestSessionButton />
            </section>

            <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
              <Link href="/" className="text-tavern-panel underline hover:text-ember">
                Back
              </Link>
            </div>
          </>
        }
      />
    </RoomViewProvider>
  );
}
