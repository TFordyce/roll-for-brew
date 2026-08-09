import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { enterTodaysRoom, getRoomRoster } from "@/lib/supabase/rooms";
import { getTodaysModifierAdjustments } from "@/lib/supabase/modifierAdjustments";
import { getUsualDrinks } from "@/lib/supabase/usualDrinks";
import { SettingsForm } from "@/app/settings/SettingsForm";
import { AdminModeToggle } from "@/app/settings/AdminModeToggle";
import { ModifierAdjustmentForm } from "@/app/settings/ModifierAdjustmentForm";
import { ModifierAdjustmentList } from "@/app/settings/ModifierAdjustmentList";
import { UsualForm } from "@/app/settings/UsualForm";
import { CardFrame } from "@/app/_components/CardFrame";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";

export default async function SettingsPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const rollInputMode = await getRollInputMode(supabase, current.playerId);
  const usualDrinks = await getUsualDrinks(supabase, current.playerId);
  const isAdmin = await getIsAdmin(supabase, current.playerId);
  const adminModeEnabled = isAdmin ? await getAdminModeEnabled() : false;

  const roomId = await enterTodaysRoom(supabase);
  const [roster, adjustments] = await Promise.all([
    getRoomRoster(supabase, roomId),
    getTodaysModifierAdjustments(supabase, roomId),
  ]);

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <ParallaxBackdrop playerId={current.playerId} />
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Settings
      </h1>

      <section className="w-full max-w-sm">
        <CardFrame title="Roll Input Mode">
          <SettingsForm rollInputMode={rollInputMode} />
        </CardFrame>
      </section>

      <section className="w-full max-w-sm">
        <CardFrame title="Usual">
          <UsualForm usualDrinks={usualDrinks} />
        </CardFrame>
      </section>

      <section className="w-full max-w-sm">
        <CardFrame title="Modifier Adjustment">
          <ModifierAdjustmentForm roster={roster} />
        </CardFrame>
      </section>

      <section className="w-full max-w-sm">
        <CardFrame title="Today's Adjustments">
          <ModifierAdjustmentList adjustments={adjustments} currentPlayerId={current.playerId} />
        </CardFrame>
      </section>

      {isAdmin ? (
        <section className="w-full max-w-sm">
          <CardFrame title="Admin">
            <AdminModeToggle enabled={adminModeEnabled} />
          </CardFrame>
        </section>
      ) : null}

      <Link
        href="/"
        className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest text-tavern-panel underline hover:text-ember"
      >
        Back
      </Link>
    </main>
  );
}
