import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { getBrewRatingAverage, getPlayerStatsSnapshot, windowFromParam } from "@/lib/supabase/stats";
import { getUsualDrinks } from "@/lib/supabase/usualDrinks";
import { ProfilePage } from "@/app/_components/ProfilePage";

export default async function PlayerProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ playerId: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const viewerPlayerId = googlePlayerId(user);
  const { playerId: targetPlayerId } = await params;
  const window = windowFromParam((await searchParams).window);

  const { data: targetPlayer } = await supabase
    .from("players")
    .select("display_name, email, avatar_url")
    .eq("id", targetPlayerId)
    .maybeSingle();

  if (!targetPlayer) {
    notFound();
  }

  const [brewRatingAverage, stats, usualDrinks] = await Promise.all([
    getBrewRatingAverage(supabase, targetPlayerId, window),
    getPlayerStatsSnapshot(supabase, targetPlayerId, window),
    getUsualDrinks(supabase, targetPlayerId),
  ]);

  return (
    <ProfilePage
      viewerPlayerId={viewerPlayerId}
      targetPlayerId={targetPlayerId}
      displayName={targetPlayer.display_name}
      email={targetPlayer.email}
      avatarUrl={targetPlayer.avatar_url}
      brewRatingAverage={brewRatingAverage}
      stats={stats}
      window={window}
      usualDrinks={usualDrinks}
    />
  );
}
