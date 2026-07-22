import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { enterTodaysRoom, getRoomRoster } from "@/lib/supabase/rooms";
import { getActiveRound, getRoundLayerParticipants, getRoundParticipants } from "@/lib/supabase/rounds";
import { getOwnRoll } from "@/lib/supabase/rolls";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { isExpectedLayerRoller } from "@/lib/supabase/stall";
import { closeRoundAction, declareInAction, startRoundAction } from "@/app/rounds/actions";
import { enforceStallTimeout } from "@/app/rounds/stallEnforcement";
import { RoundOpenLive } from "@/app/rounds/RoundOpenLive";
import { RoundReveal } from "@/app/rounds/RoundReveal";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";
import { TieBanner } from "@/app/rounds/TieBanner";
import { SpellCardPanel } from "@/app/rounds/SpellCardPanel";
import { ReactionBanner } from "@/app/rounds/ReactionBanner";
import { getMySpellCards } from "@/lib/supabase/spellCards";
import { getDispellableActiveEffects, getMyPendingCasts, getRoomActiveEffects } from "@/lib/supabase/spellCasts";
import { getOpenReactionWindow, getReactionStack } from "@/lib/supabase/reactionWindow";
import { Nav } from "@/app/Nav";
import { CardFrame } from "@/app/_components/CardFrame";
import { PlayerTile } from "@/app/_components/PlayerTile";
import { SignOutBadge } from "@/app/_components/SignOutBadge";

export default async function HomePage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const { playerId, user } = current;

  const { data: player } = await supabase
    .from("players")
    .select("display_name, email, avatar_url")
    .eq("id", playerId)
    .maybeSingle();

  const roomId = await enterTodaysRoom(supabase);
  const roster = await getRoomRoster(supabase, roomId);

  let activeRound = await getActiveRound(supabase, roomId);
  if (activeRound) {
    const stallOutcome = await enforceStallTimeout(supabase, activeRound.id);
    if (stallOutcome.action !== "none") {
      activeRound = await getActiveRound(supabase, roomId);
    }
  }
  const participants = activeRound ? await getRoundParticipants(supabase, activeRound.id) : [];
  const hasDeclared = participants.some((p) => p.playerId === playerId);
  const isStarter = activeRound?.startedBy === playerId;
  const canClose = activeRound?.status === "open" && isStarter && participants.length >= 2;

  const modifierByPlayerId = new Map(roster.map((entry) => [entry.playerId, entry.modifier]));

  const heldSpellCards = await getMySpellCards(supabase);
  const pendingSpellCasts =
    activeRound && activeRound.status === "closed"
      ? await getMyPendingCasts(supabase, activeRound.id)
      : [];
  const heldReactionCard = heldSpellCards.find((c) => c.location === "held" && c.castingTime === "R") ?? null;

  const openReactionWindow =
    activeRound && activeRound.status === "closed"
      ? await getOpenReactionWindow(supabase, activeRound.id)
      : null;
  const reactionStack =
    openReactionWindow && activeRound ? await getReactionStack(supabase, activeRound.id) : [];

  const dispellableEffects =
    activeRound && activeRound.status === "open"
      ? await getDispellableActiveEffects(supabase, activeRound.id)
      : [];

  const activeEffects = await getRoomActiveEffects(supabase, roomId);
  const effectBadgesByPlayerId = new Map<string, ("positive" | "negative")[]>();
  for (const effect of activeEffects) {
    if (effect.polarity === null) continue;
    const existing = effectBadgesByPlayerId.get(effect.targetPlayerId) ?? [];
    existing.push(effect.polarity);
    effectBadgesByPlayerId.set(effect.targetPlayerId, existing);
  }

  const currentLayer = activeRound?.currentLayer ?? 0;
  const isTiePhase = activeRound?.status === "closed" && currentLayer > 0;
  const tiedParticipants =
    activeRound && isTiePhase
      ? await getRoundLayerParticipants(supabase, activeRound.id, currentLayer)
      : [];
  const isTied = tiedParticipants.some((p) => p.playerId === playerId);

  const ownRoll = !activeRound
    ? null
    : isTiePhase
      ? isTied
        ? await getOwnRoll(supabase, activeRound.id, playerId, currentLayer)
        : null
      : activeRound.status === "closed" && hasDeclared
        ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
        : null;

  // Whether it's this player's turn to submit a roll right now: they're
  // expected to roll the round's current layer (is_expected_layer_roller,
  // issue #40 — the same SQL predicate submit_roll/submit_manual_roll gate
  // on, so this reads its answer rather than re-deriving hasDeclared/isTied/
  // excludedAt locally) and haven't already rolled it. The player's
  // roll_input_mode preference (#22) then decides which input method(s)
  // they're offered.
  const isExpectedToRoll =
    activeRound?.status === "closed"
      ? await isExpectedLayerRoller(supabase, activeRound.id, playerId, currentLayer)
      : false;
  const isPlayersTurnToRoll = isExpectedToRoll && ownRoll === null;
  const rollInputMode = isPlayersTurnToRoll ? await getRollInputMode(supabase, playerId) : null;
  const needsRollInput = isPlayersTurnToRoll && !isTiePhase;

  return (
    <main className="relative flex min-h-screen flex-col items-center gap-6 bg-wood-planks p-8">
      <SignOutBadge name={player?.display_name ?? player?.email ?? user.email ?? ""} />

      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>
      <div className="rounded-md bg-parchment/90 px-3 py-1.5 font-display uppercase tracking-widest">
        <Nav active="room" />
      </div>

      <SpellCardPanel
        heldCards={heldSpellCards}
        pendingCasts={pendingSpellCasts}
        dispellableEffects={dispellableEffects}
        roundId={activeRound?.id ?? null}
        roundIsOpen={activeRound?.status === "open"}
        roundIsClosed={activeRound?.status === "closed"}
        participants={participants}
        selfPlayerId={playerId}
      />

      {activeRound ? (
        <section className="w-full max-w-md">
          {activeRound.status === "closed" && isTiePhase ? (
            <>
              <h2 className="mb-2 text-lg font-medium text-parchment">Rolling</h2>
              <TieBanner
                key={currentLayer}
                roomId={roomId}
                roundId={activeRound.id}
                selfPlayerId={playerId}
                ownRoll={ownRoll}
                tiedParticipants={tiedParticipants}
                rollInputMode={rollInputMode}
              />
            </>
          ) : activeRound.status === "closed" ? (
            <>
              <h2 className="mb-2 text-lg font-medium text-parchment">Rolling</h2>
              <RoundReveal
                roomId={roomId}
                roundId={activeRound.id}
                selfPlayerId={playerId}
                ownRoll={ownRoll}
                participants={participants.map((entry) => ({
                  playerId: entry.playerId,
                  displayName: entry.displayName,
                  email: entry.email,
                  modifier: modifierByPlayerId.get(entry.playerId) ?? 0,
                }))}
              />
            </>
          ) : (
            <div>
              <RoundOpenLive roomId={roomId} roundId={activeRound.id} />
              <CardFrame title="Who's In?">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
                  {roster.map((entry) => (
                    <PlayerTile
                      key={entry.playerId}
                      displayName={entry.displayName}
                      email={entry.email}
                      avatarUrl={entry.avatarUrl}
                      modifier={entry.modifier}
                      joined={participants.some((p) => p.playerId === entry.playerId)}
                      isStarter={entry.playerId === activeRound.startedBy}
                      effectBadges={effectBadgesByPlayerId.get(entry.playerId) ?? []}
                    />
                  ))}
                </div>

                {!hasDeclared ? (
                  <form action={declareInAction} className="mt-4">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <button
                      type="submit"
                      className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
                    >
                      I&rsquo;m in
                    </button>
                  </form>
                ) : null}

                {isStarter ? (
                  <form action={closeRoundAction} className="mt-3">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <button
                      type="submit"
                      disabled={!canClose}
                      className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
                    >
                      {canClose ? "Let's roll" : `Need ${2 - participants.length} more to roll`}
                    </button>
                  </form>
                ) : null}
              </CardFrame>
            </div>
          )}

          {needsRollInput && rollInputMode ? (
            <RollInputPicker mode={rollInputMode} roundId={activeRound.id} />
          ) : null}
        </section>
      ) : null}

      {activeRound && openReactionWindow ? (
        <ReactionBanner
          roomId={roomId}
          roundId={activeRound.id}
          selfPlayerId={playerId}
          eligible={openReactionWindow.eligible}
          alreadyPassed={openReactionWindow.alreadyPassed}
          heldReactionCard={heldReactionCard}
          stack={reactionStack}
          participants={participants}
        />
      ) : null}

      {!activeRound ? (
        <section className="w-full max-w-md">
          <div>
            <CardFrame title="The Room">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
                {roster.map((entry) => (
                  <PlayerTile
                    key={entry.playerId}
                    displayName={entry.displayName}
                    email={entry.email}
                    avatarUrl={entry.avatarUrl}
                    modifier={entry.modifier}
                    effectBadges={effectBadgesByPlayerId.get(entry.playerId) ?? []}
                  />
                ))}
              </div>

              <form action={startRoundAction} className="mt-4">
                <button
                  type="submit"
                  className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
                >
                  Start Round
                </button>
              </form>
            </CardFrame>
          </div>
        </section>
      ) : null}

      <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
        <Link href="/settings" className="text-tavern-panel underline hover:text-ember">
          Settings
        </Link>
      </div>
    </main>
  );
}
