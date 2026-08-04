import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { getPlayerSpellCollection } from "@/lib/supabase/spellCards";
import { SpellCollectionPage } from "@/app/_components/SpellCollectionPage";

/**
 * `/collection` — a signed-in player's own spell collection (issue #134,
 * part of the Spell Collection page spec #130), rendered entirely from the
 * `get_player_spell_collection` RPC (#133): every catalog card left-joined
 * against this player's own draw counts, so a zero-draws player still gets
 * a full (all-undiscovered) grid rather than an empty page. Cross-player
 * viewing lives at `/collection/:playerId` (issue #135), sharing this same
 * `SpellCollectionPage` shell with a different target id.
 */
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

  return <SpellCollectionPage viewerPlayerId={playerId} heading="Spell Collection" cards={cards} />;
}
