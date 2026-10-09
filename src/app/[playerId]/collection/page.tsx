import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { getPlayerSpellCollection } from "@/lib/supabase/spellCards";
import { SpellCollectionPage } from "@/app/_components/SpellCollectionPage";

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

  return (
    <SpellCollectionPage
      viewerPlayerId={viewerPlayerId}
      targetPlayerId={targetPlayerId}
      heading={heading}
      cards={cards}
    />
  );
}
