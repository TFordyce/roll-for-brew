import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { SettingsForm } from "@/app/settings/SettingsForm";
import { CardFrame } from "@/app/_components/CardFrame";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";

export default async function SettingsPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const rollInputMode = await getRollInputMode(supabase, current.playerId);

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

      <Link
        href="/"
        className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest text-tavern-panel underline hover:text-ember"
      >
        Back
      </Link>
    </main>
  );
}
