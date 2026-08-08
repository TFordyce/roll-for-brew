import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { getRoomRoster, getTestRoomId } from "@/lib/supabase/rooms";
import { getActiveRound, getRoundLayerParticipants, getRoundParticipants } from "@/lib/supabase/rounds";
import { getOwnRoll } from "@/lib/supabase/rolls";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { getMyMostRecentOrder, getMyOrderForRound } from "@/lib/supabase/orders";
import { isExpectedLayerRoller } from "@/lib/supabase/stall";
import { getEffectiveTestRoomPlayerId } from "@/lib/supabase/actingAs";
import { getExpectedLayerRollerIds, getCurrentLayerRollerIds } from "@/lib/supabase/stall";
import { closeRoundAction, declareInAction, startRoundAction, withdrawDeclarationAction } from "@/app/rounds/actions";
import { enforceStallTimeout } from "@/app/rounds/stallEnforcement";
import { RoomIdleLive } from "@/app/rounds/RoomIdleLive";
import { RoundOpenLive } from "@/app/rounds/RoundOpenLive";
import { RoundReveal } from "@/app/rounds/RoundReveal";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";
import { OrderPicker } from "@/app/rounds/OrderPicker";
import { TieBanner } from "@/app/rounds/TieBanner";
import { SpellCardPanel } from "@/app/rounds/SpellCardPanel";
import { SpellCastLive } from "@/app/rounds/SpellCastLive";
import { ReactionBanner } from "@/app/rounds/ReactionBanner";
import { getInDeckSpellCards, getMySpellCards } from "@/lib/supabase/spellCards";
import { getDispellableActiveEffects, getMyPendingCasts, getRoomActiveEffects } from "@/lib/supabase/spellCasts";
import { getOpenReactionWindow, getReactionStack } from "@/lib/supabase/reactionWindow";
import { CardFrame } from "@/app/_components/CardFrame";
import { PlayerTile } from "@/app/_components/PlayerTile";
import { ActingAsSwitcher, type ActingAsOption } from "@/app/admin/test-room/ActingAsSwitcher";
import { EndTestSessionButton } from "@/app/admin/test-room/EndTestSessionButton";
import { RollForOthers, type PendingRoller } from "@/app/admin/test-room/RollForOthers";

/**
 * The Test Room (issue #101 / ADR 0002): a real, persistent room row, guarded
 * by canAccessTestRoom so it can only ever be reached by a flagged admin
 * with Admin Mode on — anyone else, or that same admin with the cookie off,
 * is redirected home rather than shown an error, since this route simply
 * doesn't exist for them.
 *
 * Everything below the switcher mirrors src/app/page.tsx's data-fetching and
 * round-flow rendering exactly (issue #102) — same components, same flow —
 * scoped to the Test Room's id and to `playerId`, the currently Acting As
 * identity (the admin's own real id, until they pick a Test Player). That
 * resolution is read-only convenience for this page's rendering; the actual
 * security boundary is enforced server-side by current_player_id() on every
 * mutating action these forms submit.
 */
export default async function TestRoomPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const { playerId: realPlayerId, user } = current;

  const isAdmin = await getIsAdmin(supabase, realPlayerId);
  const adminModeEnabled = await getAdminModeEnabled();

  if (!canAccessTestRoom({ isAdmin, adminModeEnabled })) {
    redirect("/");
  }

  const roomId = await getTestRoomId(supabase);

  if (!roomId) {
    return (
      <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
        <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
          Test Room
        </h1>
        <p className="font-body text-sm text-parchment">
          No Test Room has been seeded yet — run the admin/test-room migration first.
        </p>
      </main>
    );
  }

  const roster = await getRoomRoster(supabase, roomId);
  const playerId = await getEffectiveTestRoomPlayerId(supabase, realPlayerId);

  const { data: realPlayer } = await supabase
    .from("players")
    .select("display_name, email")
    .eq("id", realPlayerId)
    .maybeSingle();

  const switcherOptions: ActingAsOption[] = [
    {
      playerId: realPlayerId,
      displayName: realPlayer?.display_name ?? null,
      email: realPlayer?.email ?? user.email ?? "",
      isSelf: true,
    },
    ...roster.map((entry) => ({
      playerId: entry.playerId,
      displayName: entry.displayName,
      email: entry.email,
      isSelf: false,
    })),
  ];

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

  // Order (issue #226, part of #223) — mirrors page.tsx's own fetch exactly.
  const myOrderForRound = activeRound ? await getMyOrderForRound(supabase, activeRound.id, playerId) : null;
  const myMostRecentOrder =
    activeRound && myOrderForRound === null ? await getMyMostRecentOrder(supabase, playerId) : null;

  const modifierByPlayerId = new Map(roster.map((entry) => [entry.playerId, entry.modifier]));

  const heldSpellCards = await getMySpellCards(supabase, roomId);
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

  // The caller's own roll for whichever layer is *current* right now (0, or
  // a live reroll) — feeds isPlayersTurnToRoll/rollInputMode/needsRollInput
  // below regardless of phase, and doubles as TieBanner/TieRollModal's
  // ownRoll during a tie.
  const currentLayerOwnRoll = !activeRound
    ? null
    : isTiePhase
      ? isTied
        ? await getOwnRoll(supabase, activeRound.id, playerId, currentLayer)
        : null
      : activeRound.status === "closed" && hasDeclared
        ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
        : null;

  // RoundReveal's own ownRoll is always specifically layer 0's — issue #220
  // piece 4 keeps RoundReveal mounted through the tie phase too (not just
  // after it), so unlike currentLayerOwnRoll above this can't track
  // whichever layer happens to be current; RoundReveal shows layer 0's row
  // as its primary row no matter how many reroll layers came after it.
  // Outside a tie, "the current layer" already *is* layer 0, so
  // currentLayerOwnRoll above is already the answer — only an actual tie
  // phase needs its own extra fetch.
  const layerZeroOwnRoll = !isTiePhase
    ? currentLayerOwnRoll
    : activeRound?.status === "closed" && hasDeclared
      ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
      : null;

  const isExpectedToRoll =
    activeRound?.status === "closed"
      ? await isExpectedLayerRoller(supabase, activeRound.id, playerId, currentLayer)
      : false;
  const isPlayersTurnToRoll = isExpectedToRoll && currentLayerOwnRoll === null;
  const rollInputMode = isPlayersTurnToRoll ? await getRollInputMode(supabase, playerId) : null;
  const needsRollInput = isPlayersTurnToRoll && !isTiePhase;

  /**
   * Everyone still expected to roll the round's current layer, other than
   * whoever the admin is currently Acting As (that identity already has its
   * own RollInputPicker rendered above) — the roster this page's "Roll For"
   * panel (issue #102 follow-up) lets the admin fill in or randomly roll for,
   * without switching Acting As once per person.
   */
  const nameByPlayerId = new Map(switcherOptions.map((option) => [option.playerId, option]));
  let pendingRollers: PendingRoller[] = [];
  if (activeRound && activeRound.status === "closed") {
    const [expectedIds, rolledIds] = await Promise.all([
      getExpectedLayerRollerIds(supabase, activeRound.id, currentLayer),
      getCurrentLayerRollerIds(supabase, activeRound.id),
    ]);
    pendingRollers = [...expectedIds]
      .filter((id) => id !== playerId && !rolledIds.has(id))
      .map((id) => {
        const option = nameByPlayerId.get(id);
        return { playerId: id, displayName: option?.displayName ?? null, email: option?.email ?? "" };
      });
  }

  // Only fetched when there's actually someone to roll for — the "force
  // crit card" picker (RollForOthers) is the only consumer.
  const inDeckCards = pendingRollers.length > 0 ? await getInDeckSpellCards(supabase, roomId) : [];

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Test Room
      </h1>

      <section className="w-full max-w-md">
        <ActingAsSwitcher options={switcherOptions} currentPlayerId={playerId} />
      </section>

      {activeRound ? <SpellCastLive roomId={roomId} roundId={activeRound.id} /> : null}

      <SpellCardPanel
        heldCards={heldSpellCards}
        pendingCasts={pendingSpellCasts}
        dispellableEffects={dispellableEffects}
        roundId={activeRound?.id ?? null}
        roundIsOpen={activeRound?.status === "open"}
        roundIsClosed={activeRound?.status === "closed"}
        participants={participants}
        selfPlayerId={playerId}
        roomId={roomId}
      />

      {activeRound ? (
        <section className="w-full max-w-md">
          {activeRound.status === "closed" ? (
            <div>
              {isTiePhase && tiedParticipants.length > 0 ? (
                <TieBanner
                  key={currentLayer}
                  roomId={roomId}
                  roundId={activeRound.id}
                  selfPlayerId={playerId}
                  ownRoll={currentLayerOwnRoll}
                  tiedParticipants={tiedParticipants.map((entry) => ({
                    ...entry,
                    modifier: modifierByPlayerId.get(entry.playerId) ?? 0,
                  }))}
                  rollInputMode={rollInputMode}
                />
              ) : null}

              <RoundReveal
                roomId={roomId}
                roundId={activeRound.id}
                selfPlayerId={playerId}
                ownRoll={layerZeroOwnRoll}
                participants={participants.map((entry) => ({
                  playerId: entry.playerId,
                  displayName: entry.displayName,
                  email: entry.email,
                  modifier: modifierByPlayerId.get(entry.playerId) ?? 0,
                }))}
              />
            </div>
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

                {myOrderForRound === null ? (
                  <p className="mt-4 text-xs text-gilt-bright">🫖 Don&rsquo;t forget to set your Order below.</p>
                ) : null}

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

                {hasDeclared && !isStarter ? (
                  <form action={withdrawDeclarationAction} className="mt-4">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <button
                      type="submit"
                      className="w-full rounded-md border-2 border-gilt-dark bg-transparent px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment"
                    >
                      Not in after all
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

          <OrderPicker
            key={activeRound.id}
            roundId={activeRound.id}
            initialDrinkType={myOrderForRound ?? myMostRecentOrder}
          />

          {needsRollInput && rollInputMode ? (
            <RollInputPicker mode={rollInputMode} roundId={activeRound.id} />
          ) : null}

          <RollForOthers roundId={activeRound.id} pendingRollers={pendingRollers} inDeckCards={inDeckCards} />
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
            <RoomIdleLive roomId={roomId} />
            <CardFrame title="Test Roster">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
                {roster.map((entry) => (
                  <PlayerTile
                    key={entry.playerId}
                    displayName={entry.displayName}
                    email={entry.email}
                    avatarUrl={entry.avatarUrl}
                    modifier={entry.modifier}
                    isTest={entry.isTest}
                    effectBadges={effectBadgesByPlayerId.get(entry.playerId) ?? []}
                  />
                ))}
              </div>

              <form action={startRoundAction} className="mt-4">
                <input type="hidden" name="roomId" value={roomId} />
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

      <section className="w-full max-w-md">
        <EndTestSessionButton />
      </section>

      <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
        <Link href="/" className="text-tavern-panel underline hover:text-ember">
          Back
        </Link>
      </div>
    </main>
  );
}
