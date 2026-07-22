import { redirect } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  getCupsMadeLeaderboard,
  getLossPercentageLeaderboard,
  getModifierPeakLeaderboard,
  getPlayerAvatars,
  getRoomHistory,
  getRoomRounds,
  getRoundsLostLeaderboard,
  type StatsWindow,
} from "@/lib/supabase/stats";
import { Nav } from "@/app/Nav";
import { CardFrame } from "@/app/_components/CardFrame";
import { RankRow } from "@/app/_components/RankRow";

function windowFromParam(value: string | undefined): StatsWindow {
  return value === "last_30_days" ? "last_30_days" : "all_time";
}

function WindowToggle({
  window,
  roomId,
}: {
  window: StatsWindow;
  roomId: string | null;
}) {
  const roomQuery = roomId ? `&room=${roomId}` : "";
  return (
    <div className="flex gap-3 font-display text-xs uppercase tracking-widest">
      <Link
        href={`/stats?window=all_time${roomQuery}`}
        className={
          window === "all_time" ? "text-gilt-bright" : "text-parchment-dim"
        }
      >
        All-time
      </Link>
      <Link
        href={`/stats?window=last_30_days${roomQuery}`}
        className={
          window === "last_30_days" ? "text-gilt-bright" : "text-parchment-dim"
        }
      >
        Last 30 days
      </Link>
    </div>
  );
}

/**
 * One divider-separated leaderboard inside the Leaderboards `CardFrame`
 * (issue #79) — a heading plus its `RankRow` list, or the shared empty
 * state when a leaderboard has no entries yet.
 */
function LeaderboardSection({
  title,
  children,
  isEmpty,
  first = false,
}: {
  title: string;
  children: ReactNode;
  isEmpty: boolean;
  first?: boolean;
}) {
  return (
    <div className={first ? "" : "mt-4 border-t border-gilt-dark pt-4"}>
      <h3 className="mb-1 font-display text-xs font-semibold uppercase tracking-widest text-gilt-bright">
        {title}
      </h3>
      <div className="divide-y divide-gilt-dark/40">
        {isEmpty ? (
          <p className="py-2 text-sm text-parchment-dim">No rounds yet.</p>
        ) : (
          children
        )}
      </div>
    </div>
  );
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

  const [cupsMade, roundsLost, lossPercentage, modifierPeak, roomHistory] =
    await Promise.all([
      getCupsMadeLeaderboard(supabase, window),
      getRoundsLostLeaderboard(supabase, window),
      getLossPercentageLeaderboard(supabase, window),
      getModifierPeakLeaderboard(supabase, window),
      getRoomHistory(supabase),
    ]);

  const roomRounds = selectedRoomId
    ? await getRoomRounds(supabase, selectedRoomId)
    : [];

  const avatarsByPlayerId = await getPlayerAvatars(supabase, [
    ...cupsMade.map((e) => e.playerId),
    ...roundsLost.map((e) => e.playerId),
    ...lossPercentage.map((e) => e.playerId),
    ...modifierPeak.map((e) => e.playerId),
    ...roomRounds.map((r) => r.starterId),
  ]);

  return (
    <main className="relative flex min-h-screen flex-col items-center gap-6 bg-wood-planks p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>
      <Nav active="stats" />

      <section className="w-full max-w-md">
        <CardFrame
          title={
            <div className="flex items-center justify-between normal-case tracking-normal">
              <span className="font-display text-sm font-semibold uppercase tracking-widest text-gilt-bright">
                Leaderboards
              </span>
              <WindowToggle window={window} roomId={selectedRoomId} />
            </div>
          }
        >
          <LeaderboardSection
            title="Most cups made"
            isEmpty={cupsMade.length === 0}
            first
          >
            {cupsMade.map((entry, i) => (
              <RankRow
                key={entry.playerId}
                rank={i + 1}
                displayName={entry.displayName}
                email={entry.email}
                avatarUrl={avatarsByPlayerId.get(entry.playerId) ?? null}
                value={entry.cupsMade}
              />
            ))}
          </LeaderboardSection>

          <LeaderboardSection
            title="Luckiest (fewest rounds lost)"
            isEmpty={roundsLost.length === 0}
          >
            {roundsLost.map((entry, i) => (
              <RankRow
                key={entry.playerId}
                rank={i + 1}
                displayName={entry.displayName}
                email={entry.email}
                avatarUrl={avatarsByPlayerId.get(entry.playerId) ?? null}
                value={entry.roundsLost}
              />
            ))}
          </LeaderboardSection>

          <LeaderboardSection
            title="Loss percentage"
            isEmpty={lossPercentage.length === 0}
          >
            {lossPercentage.map((entry, i) => (
              <RankRow
                key={entry.playerId}
                rank={i + 1}
                displayName={entry.displayName}
                email={entry.email}
                avatarUrl={avatarsByPlayerId.get(entry.playerId) ?? null}
                value={`${entry.lossPercentage}% (${entry.roundsLost}/${entry.roundsPlayed})`}
              />
            ))}
          </LeaderboardSection>

          <LeaderboardSection
            title="Highest modifier ever reached"
            isEmpty={modifierPeak.length === 0}
          >
            {modifierPeak.map((entry, i) => (
              <RankRow
                key={entry.playerId}
                rank={i + 1}
                displayName={entry.displayName}
                email={entry.email}
                avatarUrl={avatarsByPlayerId.get(entry.playerId) ?? null}
                value={entry.peakModifier}
              />
            ))}
          </LeaderboardSection>
        </CardFrame>
      </section>

      <section className="w-full max-w-md">
        <CardFrame title="Room History">
          <div className="divide-y divide-gilt-dark/40">
            {roomHistory.map((room) => (
              <Link
                key={room.roomId}
                href={`/stats?window=${window}&room=${room.roomId}`}
                className={`flex items-center justify-between py-2 text-sm ${
                  selectedRoomId === room.roomId
                    ? "text-gilt-bright"
                    : "text-parchment"
                }`}
              >
                <span>{room.date}</span>
                <span className="font-mono text-parchment-dim">
                  {room.resolvedRoundCount} rounds
                </span>
              </Link>
            ))}
            {roomHistory.length === 0 ? (
              <p className="py-2 text-sm text-parchment-dim">No rooms yet.</p>
            ) : null}
          </div>

          {selectedRoomId ? (
            <div className="mt-3 divide-y divide-gilt-dark/40 border-t border-gilt-dark pt-3">
              {roomRounds.map((round) => (
                <div key={round.roundId} className="py-2">
                  <RankRow
                    displayName={round.starterDisplayName}
                    email={round.starterEmail}
                    avatarUrl={avatarsByPlayerId.get(round.starterId) ?? null}
                    value={`${round.cupsMade} cups`}
                  />
                  <p className="pl-10 text-xs text-parchment-dim">
                    Brewer: {round.brewerDisplayName ?? round.brewerEmail}
                  </p>
                </div>
              ))}
              {roomRounds.length === 0 ? (
                <p className="py-2 text-sm text-parchment-dim">
                  No resolved rounds that day.
                </p>
              ) : null}
            </div>
          ) : null}
        </CardFrame>
      </section>
    </main>
  );
}
