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
import { getMyMostRecentOrder, getMyOrderableRound, getMyOrderForRound } from "@/lib/supabase/orders";
import { getRoundMenu } from "@/lib/supabase/menu";
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
import { RoundMenu } from "@/app/rounds/RoundMenu";
import { MenuLive } from "@/app/rounds/MenuLive";
import { TieBanner } from "@/app/rounds/TieBanner";
import { SpellCardPanel } from "@/app/rounds/SpellCardPanel";
import { HeldCardThumbnail } from "@/app/rounds/HeldCardThumbnail";
import { SpellCastLive } from "@/app/rounds/SpellCastLive";
import { ReactionBanner } from "@/app/rounds/ReactionBanner";
import { getInDeckSpellCards, getMySpellCards } from "@/lib/supabase/spellCards";
import {
  type ActiveEffectBadge,
  getDispellableActiveEffects,
  getHeistTargetIds,
  getMyPendingCasts,
  getRoomActiveEffects,
} from "@/lib/supabase/spellCasts";
import {
  getOpenReactionWindow,
  getReactionSkipVote,
  getReactionStack,
  getReactionWindowPendingPlayers,
} from "@/lib/supabase/reactionWindow";
import { CardFrame } from "@/app/_components/CardFrame";
import { PlayerTile } from "@/app/_components/PlayerTile";
import { ActingAsSwitcher, type ActingAsOption } from "@/app/admin/test-room/ActingAsSwitcher";
import { EndTestSessionButton } from "@/app/admin/test-room/EndTestSessionButton";
import { RollForOthers, type PendingRoller } from "@/app/admin/test-room/RollForOthers";
import { RoomViewProvider } from "@/lib/room/RoomViewProvider";
import { loadInitialRoomView } from "@/lib/room/loadInitialRoomView";
import { RoomScreen } from "@/app/rounds/RoomScreen";

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

  const initialView = await loadInitialRoomView(supabase, roomId);
  if (initialView) {
    const { data: viewRealPlayer } = await supabase
      .from("players")
      .select("display_name, email")
      .eq("id", realPlayerId)
      .maybeSingle();
    const viewOptions: ActingAsOption[] = [
      {
        playerId: realPlayerId,
        displayName: viewRealPlayer?.display_name ?? null,
        email: viewRealPlayer?.email ?? user.email ?? "",
        isSelf: true,
      },
      ...initialView.room.roster.map((entry) => ({
        playerId: entry.playerId,
        displayName: entry.displayName,
        email: entry.email ?? "",
        isSelf: false,
      })),
    ];
    return (
      <RoomViewProvider roomId={roomId} initialView={initialView}>
        <RoomScreen
          variant="testRoom"
          top={
            <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
              Test Room
            </h1>
          }
          afterTopPanels={
            <section className="w-full max-w-md">
              <ActingAsSwitcher options={viewOptions} currentPlayerId={initialView.viewer.playerId} />
            </section>
          }
          bottom={
            <>
              <section className="w-full max-w-md">
                <EndTestSessionButton />
              </section>

              <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
                <Link href="/" className="text-tavern-panel underline hover:text-ember">
                  Back
                </Link>
              </div>
            </>
          }
        />
      </RoomViewProvider>
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

  const orderRoundId = activeRound ? activeRound.id : await getMyOrderableRound(supabase, roomId);
  const myOrderForRound = orderRoundId ? await getMyOrderForRound(supabase, orderRoundId, playerId) : null;
  const myMostRecentOrder =
    orderRoundId && myOrderForRound === null ? await getMyMostRecentOrder(supabase, playerId) : null;

  const menuEntries = orderRoundId ? await getRoundMenu(supabase, orderRoundId) : [];
  const menuParticipants = activeRound
    ? participants
    : orderRoundId
      ? await getRoundParticipants(supabase, orderRoundId)
      : [];

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
  const reactionWindowPendingPlayers =
    openReactionWindow && activeRound ? await getReactionWindowPendingPlayers(supabase, activeRound.id) : [];
  const reactionSkipVote =
    openReactionWindow && activeRound ? await getReactionSkipVote(supabase, activeRound.id) : null;

  const dispellableEffects =
    activeRound && activeRound.status === "open"
      ? await getDispellableActiveEffects(supabase, activeRound.id)
      : [];

  const heistTargetIds =
    activeRound &&
    activeRound.status === "open" &&
    heldSpellCards.some((c) => c.location === "held" && c.cardName === "Tea Heist")
      ? await getHeistTargetIds(supabase, activeRound.id)
      : [];

  const activeEffects = await getRoomActiveEffects(supabase, roomId);
  const effectBadgesByPlayerId = new Map<string, ActiveEffectBadge[]>();
  for (const effect of activeEffects) {
    if (effect.polarity === null) continue;
    const existing = effectBadgesByPlayerId.get(effect.targetPlayerId) ?? [];
    existing.push(effect);
    effectBadgesByPlayerId.set(effect.targetPlayerId, existing);
  }

  const currentLayer = activeRound?.currentLayer ?? 0;
  const isTiePhase = activeRound?.status === "closed" && currentLayer > 0;
  const tiedParticipants =
    activeRound && isTiePhase
      ? await getRoundLayerParticipants(supabase, activeRound.id, currentLayer)
      : [];
  const isTied = tiedParticipants.some((p) => p.playerId === playerId);

  const currentLayerOwnRoll = !activeRound
    ? null
    : isTiePhase
      ? isTied
        ? await getOwnRoll(supabase, activeRound.id, playerId, currentLayer)
        : null
      : activeRound.status === "closed" && hasDeclared
        ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
        : null;

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

  const inDeckCards = pendingRollers.length > 0 ? await getInDeckSpellCards(supabase, roomId) : [];

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Test Room
      </h1>

      {orderRoundId ? <RoundMenu entries={menuEntries} participants={menuParticipants} /> : null}

      <section className="w-full max-w-md">
        <ActingAsSwitcher options={switcherOptions} currentPlayerId={playerId} />
      </section>

      {activeRound ? <SpellCastLive roomId={roomId} roundId={activeRound.id} /> : null}

      <SpellCardPanel
        heldCards={heldSpellCards}
        pendingCasts={pendingSpellCasts}
        roundId={activeRound?.id ?? null}
        roundIsClosed={activeRound?.status === "closed"}
        participants={participants}
        selfPlayerId={playerId}
        roomId={roomId}
      />
      <HeldCardThumbnail
        heldCards={heldSpellCards}
        dispellableEffects={dispellableEffects}
        roundId={activeRound?.id ?? null}
        roundIsOpen={activeRound?.status === "open"}
        participants={participants}
        heistTargetIds={heistTargetIds}
        selfPlayerId={playerId}
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
                hasOpenReactionWindow={openReactionWindow !== null}
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

          {needsRollInput && rollInputMode ? (
            <RollInputPicker mode={rollInputMode} roundId={activeRound.id} />
          ) : null}

          <RollForOthers roundId={activeRound.id} pendingRollers={pendingRollers} inDeckCards={inDeckCards} />
        </section>
      ) : null}

      {orderRoundId ? (
        <section className="w-full max-w-md">
          <MenuLive roomId={roomId} roundId={orderRoundId} />
          <OrderPicker
            key={orderRoundId}
            roundId={orderRoundId}
            initialDrinkType={myOrderForRound ?? myMostRecentOrder}
          />
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
          pendingPlayers={reactionWindowPendingPlayers}
          skipVote={reactionSkipVote}
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
