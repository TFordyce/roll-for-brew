import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { getPlayerSpellCollection } from "@/lib/supabase/spellCards";
import { SpellCollectionPage } from "@/app/_components/SpellCollectionPage";

/**
 * `/collection/:playerId` — any player's spell collection (issue #135, part
 * of the Spell Collection page spec #130), reusing `/collection`'s own-
 * collection shell (issue #134) with the URL param as the RPC target
 * instead of the viewer's own id. Every place a player's name/row already
 * renders (`RankRow` on `/stats`, the room roster's `PlayerTile`s) links
 * here. Viewing your own id this way just renders the same thing
 * `/collection` does.
 */
export default async function PlayerCollectionPage({
  params,
}: {
  params: Promise<{ playerId: string }>;
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

  const { data: targetPlayer } = await supabase
    .from("players")
    .select("display_name, email")
    .eq("id", targetPlayerId)
    .maybeSingle();

  if (!targetPlayer) {
    notFound();
  }

  const cards = await getPlayerSpellCollection(supabase, targetPlayerId);
  const heading =
    targetPlayerId === viewerPlayerId
      ? "Spell Collection"
      : `${targetPlayer.display_name ?? targetPlayer.email}'s Collection`;

  return <SpellCollectionPage viewerPlayerId={viewerPlayerId} heading={heading} cards={cards} />;
}
