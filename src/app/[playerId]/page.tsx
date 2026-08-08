import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { getBrewRatingAverage, getPlayerStatsSnapshot, windowFromParam } from "@/lib/supabase/stats";
import { ProfilePage } from "@/app/_components/ProfilePage";

/**
 * `/:playerId` — a player's profile page (issue #212, part of the Brew
 * Rating spec #208): header, Brew Rating average, the four existing
 * per-player stats (with the same all-time/last-30-days `?window=` toggle
 * `/stats` uses), and a link down to `/:playerId/collection`. Mirrors
 * `/collection/:playerId`'s shape (now moved to `/:playerId/collection`,
 * see `src/app/[playerId]/collection/page.tsx`): auth-gate, resolve viewer
 * identity, fetch the target player row, `notFound()` if missing, fetch
 * data via typed lib helpers, delegate to a presentational component.
 */
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

  const [brewRatingAverage, stats] = await Promise.all([
    getBrewRatingAverage(supabase, targetPlayerId, window),
    getPlayerStatsSnapshot(supabase, targetPlayerId, window),
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
    />
  );
}
