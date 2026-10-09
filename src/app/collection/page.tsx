import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { getPlayerSpellCollection } from "@/lib/supabase/spellCards";
import { SpellCollectionPage } from "@/app/_components/SpellCollectionPage";

export default async function CollectionPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const playerId = googlePlayerId(user);
  const cards = await getPlayerSpellCollection(supabase, playerId);

  return (
    <SpellCollectionPage
      viewerPlayerId={playerId}
      targetPlayerId={playerId}
      heading="Spell Collection"
      cards={cards}
    />
  );
}
