import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { enterTodaysRoom } from "@/lib/supabase/rooms";
import { initialsFrom } from "@/lib/game/initials";
import { Nav } from "@/app/Nav";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { SignOutBadge } from "@/app/_components/SignOutBadge";
import { RoomViewProvider } from "@/lib/room/RoomViewProvider";
import { loadInitialRoomView } from "@/lib/room/loadInitialRoomView";
import { RoomScreen } from "@/app/rounds/RoomScreen";

export default async function HomePage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const { playerId, user } = current;

  const { data: player } = await supabase
    .from("players")
    .select("display_name, email, avatar_url")
    .eq("id", playerId)
    .maybeSingle();

  const isAdmin = await getIsAdmin(supabase, playerId);
  const adminModeEnabled = isAdmin ? await getAdminModeEnabled() : false;
  const showAdminMenu = canAccessTestRoom({ isAdmin, adminModeEnabled });

  const roomId = await enterTodaysRoom(supabase);

  const initialView = await loadInitialRoomView(supabase, roomId);
  const signOutName = player?.display_name ?? player?.email ?? user.email ?? "";
  return (
    <RoomViewProvider roomId={roomId} initialView={initialView}>
      <RoomScreen
        variant="home"
        raterInitials={initialsFrom(player?.display_name ?? null, player?.email ?? user.email ?? "")}
        top={
          <>
            <ParallaxBackdrop playerId={playerId} />
            <SignOutBadge name={signOutName} showAdminMenu={showAdminMenu} />
          </>
        }
        afterTopPanels={
          <>
            <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
              Roll for Brew
            </h1>
            <Nav active="room" />
          </>
        }
        bottom={
          <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
            <Link href="/settings" className="text-tavern-panel underline hover:text-ember">
              Settings
            </Link>
          </div>
        }
      />
    </RoomViewProvider>
  );
}
