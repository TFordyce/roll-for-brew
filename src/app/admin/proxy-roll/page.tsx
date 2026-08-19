import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { enterTodaysRoom, getAbsentRealPlayers } from "@/lib/supabase/rooms";
import { getActiveRound, roundHasAnyRolls } from "@/lib/supabase/rounds";
import { CardFrame } from "@/app/_components/CardFrame";
import { ProxyRollForm } from "./ProxyRollForm";

/**
 * `/admin/proxy-roll` (issue #273, the "Proxy Roll" glossary entry): lets
 * an admin fold a player who's physically at the table but hasn't opened
 * the app today into today's genuinely live round, entering the value they
 * read out loud on their behalf. Gated the same way as /admin/rounds,
 * /admin/adjustments, /admin/cards — canAccessTestRoom (is_admin + the
 * Admin Mode cookie) — but real-room-scoped, not Test-Room-only like
 * submit_roll_as/submit_manual_roll_as (0029) it extends the pattern from.
 *
 * The eligible window mirrors admin_proxy_roll's own guard exactly: today's
 * room needs an active round that's either still open, or closed with no
 * rolls submitted for it yet. Once any roll lands, the window (and this
 * page's form) is gone — the RPC itself is the enforcement; this is just
 * matching UI so an admin isn't shown a form that will fail.
 */
export default async function AdminProxyRollPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const { playerId: realPlayerId } = current;
  const isAdmin = await getIsAdmin(supabase, realPlayerId);
  const adminModeEnabled = await getAdminModeEnabled();

  if (!canAccessTestRoom({ isAdmin, adminModeEnabled })) {
    redirect("/");
  }

  const roomId = await enterTodaysRoom(supabase);
  const activeRound = await getActiveRound(supabase, roomId);
  const hasAnyRolls = activeRound ? await roundHasAnyRolls(supabase, activeRound.id) : false;
  const eligible = activeRound !== null && !hasAnyRolls;
  const absentPlayers = eligible ? await getAbsentRealPlayers(supabase, roomId) : [];

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">Proxy Roll</h1>

      <section className="w-full max-w-md">
        <CardFrame title="Enter a roll on someone's behalf">
          {!activeRound ? (
            <p className="font-body text-sm text-parchment-dim">
              No round is currently in progress in today's room.
            </p>
          ) : hasAnyRolls ? (
            <p className="font-body text-sm text-parchment-dim">
              Today's round has already started rolling — a Proxy Roll can no longer join it.
            </p>
          ) : absentPlayers.length === 0 ? (
            <p className="font-body text-sm text-parchment-dim">
              Every real player is already present in today's room.
            </p>
          ) : (
            <ProxyRollForm roundId={activeRound.id} absentPlayers={absentPlayers} />
          )}
        </CardFrame>
      </section>

      <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
        <Link href="/admin/test-room" className="text-tavern-panel underline hover:text-ember">
          Back
        </Link>
      </div>
    </main>
  );
}
