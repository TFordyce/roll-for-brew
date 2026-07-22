import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getCupsMadeLeaderboard,
  getLossPercentageLeaderboard,
  getModifierPeakLeaderboard,
  getRoomHistory,
  getRoomRounds,
  getRoundsLostLeaderboard,
  type StatsWindow,
} from "@/lib/supabase/stats";
import { Nav } from "@/app/Nav";

function windowFromParam(value: string | undefined): StatsWindow {
  return value === "last_30_days" ? "last_30_days" : "all_time";
}

function WindowToggle({ window, roomId }: { window: StatsWindow; roomId: string | null }) {
  const roomQuery = roomId ? `&room=${roomId}` : "";
  return (
    <div className="flex gap-3 text-xs">
      <Link
        href={`/stats?window=all_time${roomQuery}`}
        className={window === "all_time" ? "font-semibold underline" : "text-neutral-500"}
      >
        All-time
      </Link>
      <Link
        href={`/stats?window=last_30_days${roomQuery}`}
        className={window === "last_30_days" ? "font-semibold underline" : "text-neutral-500"}
      >
        Last 30 days
      </Link>
    </div>
  );
}

function nameOf(entry: { displayName: string | null; email: string }) {
  return entry.displayName ?? entry.email;
}

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; room?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const params = await searchParams;
  const window = windowFromParam(params.window);
  const selectedRoomId = params.room ?? null;

  const [cupsMade, roundsLost, lossPercentage, modifierPeak, roomHistory] = await Promise.all([
    getCupsMadeLeaderboard(supabase, window),
    getRoundsLostLeaderboard(supabase, window),
    getLossPercentageLeaderboard(supabase, window),
    getModifierPeakLeaderboard(supabase, window),
    getRoomHistory(supabase),
  ]);

  const roomRounds = selectedRoomId ? await getRoomRounds(supabase, selectedRoomId) : [];

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Roll for Brew</h1>
      <Nav active="stats" />

      <section className="w-full max-w-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Most cups made</h2>
          <WindowToggle window={window} roomId={selectedRoomId} />
        </div>
        <ol className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {cupsMade.map((entry, i) => (
            <li key={entry.playerId} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>
                {i + 1}. {nameOf(entry)}
              </span>
              <span className="font-mono">{entry.cupsMade}</span>
            </li>
          ))}
          {cupsMade.length === 0 ? <li className="px-3 py-2 text-sm text-neutral-500">No rounds yet.</li> : null}
        </ol>
      </section>

      <section className="w-full max-w-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Luckiest (fewest rounds lost)</h2>
          <WindowToggle window={window} roomId={selectedRoomId} />
        </div>
        <ol className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {roundsLost.map((entry, i) => (
            <li key={entry.playerId} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>
                {i + 1}. {nameOf(entry)}
              </span>
              <span className="font-mono">{entry.roundsLost}</span>
            </li>
          ))}
          {roundsLost.length === 0 ? <li className="px-3 py-2 text-sm text-neutral-500">No rounds yet.</li> : null}
        </ol>
      </section>

      <section className="w-full max-w-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Loss percentage</h2>
          <WindowToggle window={window} roomId={selectedRoomId} />
        </div>
        <ol className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {lossPercentage.map((entry, i) => (
            <li key={entry.playerId} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>
                {i + 1}. {nameOf(entry)}
              </span>
              <span className="font-mono">
                {entry.lossPercentage}% ({entry.roundsLost}/{entry.roundsPlayed})
              </span>
            </li>
          ))}
          {lossPercentage.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">No rounds yet.</li>
          ) : null}
        </ol>
      </section>

      <section className="w-full max-w-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Highest modifier ever reached</h2>
          <WindowToggle window={window} roomId={selectedRoomId} />
        </div>
        <ol className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {modifierPeak.map((entry, i) => (
            <li key={entry.playerId} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>
                {i + 1}. {nameOf(entry)}
              </span>
              <span className="font-mono">{entry.peakModifier}</span>
            </li>
          ))}
          {modifierPeak.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">No rounds yet.</li>
          ) : null}
        </ol>
      </section>

      <section className="w-full max-w-sm">
        <h2 className="mb-2 text-lg font-medium">Room history</h2>
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {roomHistory.map((room) => (
            <li key={room.roomId} className="px-3 py-2 text-sm">
              <Link
                href={`/stats?window=${window}&room=${room.roomId}`}
                className={
                  selectedRoomId === room.roomId
                    ? "flex items-center justify-between font-semibold underline"
                    : "flex items-center justify-between"
                }
              >
                <span>{room.date}</span>
                <span className="font-mono">{room.resolvedRoundCount} rounds</span>
              </Link>
            </li>
          ))}
          {roomHistory.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">No rooms yet.</li>
          ) : null}
        </ul>

        {selectedRoomId ? (
          <ul className="mt-3 divide-y divide-neutral-200 rounded border border-neutral-200">
            {roomRounds.map((round) => (
              <li key={round.roundId} className="px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{round.starterDisplayName ?? round.starterEmail} started</span>
                  <span className="font-mono">{round.cupsMade} cups</span>
                </div>
                <div className="text-neutral-500">
                  Brewer: {round.brewerDisplayName ?? round.brewerEmail}
                </div>
              </li>
            ))}
            {roomRounds.length === 0 ? (
              <li className="px-3 py-2 text-sm text-neutral-500">No resolved rounds that day.</li>
            ) : null}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
