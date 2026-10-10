"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomRefresh } from "@/lib/room/roomViewContext";
import { createClient } from "@/lib/supabase/client";
import { type LayerRollsRevealedPayload, type RoundRevealedPayload } from "@/lib/supabase/realtime";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { getRoundRecap, type RoundRecapData } from "@/lib/supabase/roundRecap";
import { buildRerollChain, buildRoundRecap } from "@/lib/game/roundRecap";
import { CardFrame } from "@/app/_components/CardFrame";
import { RollRowExpression } from "@/app/_components/RollRowExpression";
import { DieIcon } from "@/app/_components/DieIcon";
import { ModifierBreakdown } from "@/app/_components/ModifierBreakdown";
import { RoundRecap, scrollToRecapPlayer } from "@/app/_components/RoundRecap";
import { RerollChainRows } from "@/app/_components/RerollChainRows";
import { ScrappedGenerationDisclosure } from "@/app/_components/ScrappedGenerationDisclosure";

export type RoundRevealParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
  modifier: number;
};

const RESULTS_TIMEOUT_MS = 5 * 60 * 1000;

export function RoundReveal({
  roomId,
  roundId,
  participants,
  selfPlayerId,
  ownRoll,
  hasOpenReactionWindow,
  onRevealed,
  onResultsDone,
}: {
  roomId: string;
  roundId: string;
  participants: RoundRevealParticipant[];
  selfPlayerId: string;
  ownRoll: number | null;
  hasOpenReactionWindow: boolean;
  onRevealed?: () => void;
  onResultsDone?: () => void;
}) {
  const refresh = useRoomRefresh();
  const [rolls, setRolls] = useState<LayerRollsRevealedPayload["rolls"] | null>(null);
  const [brewerId, setBrewerId] = useState<string | null>(null);
  const [showKettleModal, setShowKettleModal] = useState(false);
  const [recap, setRecap] = useState<RoundRecapData | null>(null);
  const [recapRefreshToken, setRecapRefreshToken] = useState(0);
  const bumpRecap = () => setRecapRefreshToken((t) => t + 1);
  const resultsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResultsTimeout = useCallback(() => {
    if (resultsTimeoutRef.current !== null) {
      clearTimeout(resultsTimeoutRef.current);
      resultsTimeoutRef.current = null;
    }
  }, []);

  function startResultsTimeout() {
    clearResultsTimeout();
    resultsTimeoutRef.current = setTimeout(() => (onResultsDone ?? refresh)(), RESULTS_TIMEOUT_MS);
  }

  useEffect(() => {
    setRolls(null);
    setBrewerId(null);
    setShowKettleModal(false);
    setRecap(null);
    setRecapRefreshToken(0);
    clearResultsTimeout();
    return clearResultsTimeout;
  }, [roomId, roundId, clearResultsTimeout]);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    getRoundRecap(supabase, roundId)
      .then((data) => {
        if (!cancelled) setRecap(data);
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [roundId, recapRefreshToken]);

  useRoomChannel(roomId, roundId, {
    "layer-rolls-revealed": (payload) => {
      if (payload.layer === 0) setRolls(payload.rolls);
      bumpRecap();
    },
    "round-revealed": (payload: RoundRevealedPayload) => {
      if (payload.layer === 0) setRolls(payload.rolls);
      bumpRecap();
      setBrewerId(payload.brewerId);
      onRevealed?.();
      if (payload.brewerId === selfPlayerId) {
        setShowKettleModal(true);
      } else {
        startResultsTimeout();
      }
    },
    "layer-tied": () => refresh(),
    "room-changed": () => {
      bumpRecap();
      if (!hasOpenReactionWindow) refresh();
    },
  });

  function dismissKettleModal() {
    setShowKettleModal(false);
    startResultsTimeout();
  }

  const revealedValueByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.value]) ?? []);
  const discardedValueByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.discardedValue]) ?? []);
  const enteredByAdminByPlayerId = new Map(rolls?.map((r) => [r.playerId, r.enteredByAdmin]) ?? []);
  const brewer = participants.find((p) => p.playerId === brewerId);
  const firstNameByPlayerId = new Map(
    participants.map((p) => [p.playerId, firstNameOrFallback(p.displayName, p.email)]),
  );

  const recapDisplayName = (playerId: string) => firstNameByPlayerId.get(playerId) ?? playerId;
  const recapModel = recap
    ? buildRoundRecap({
        data: recap,
        displayName: recapDisplayName,
      })
    : null;
  const hasRecap = recapModel?.hasContent ?? false;
  const provisional = recapModel?.provisional ?? false;

  const scrappedGenerations = recap?.scrappedGenerations ?? [];

  return (
    <>
      {showKettleModal && brewer ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="rounded-lg border-4 border-gilt bg-tavern-panel p-6 text-center shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.5)]">
            <p className="font-display text-xl font-semibold uppercase tracking-widest text-gilt-bright">
              Get the kettle on, {brewer.displayName ?? brewer.email}
            </p>
            <button
              type="button"
              onClick={dismissKettleModal}
              className="mt-5 w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
            >
              Show results
            </button>
          </div>
        </div>
      ) : null}

      {scrappedGenerations.length > 0 ? (
        <ScrappedGenerationDisclosure
          generations={scrappedGenerations}
          roster={participants.map((p) => p.playerId)}
          displayName={recapDisplayName}
        />
      ) : null}

      {hasRecap && recapModel ? <RoundRecap model={recapModel} /> : null}

      <CardFrame title="Rolling">
        {provisional ? (
          <p className="mb-2 font-body text-[11px] italic text-parchment-dim">so far — reactions pending</p>
        ) : null}
        <ul className="divide-y divide-gilt-dark/40">
          {participants.map((p) => {
            const revealedValue = revealedValueByPlayerId.get(p.playerId);
            const value = revealedValue ?? (p.playerId === selfPlayerId ? ownRoll : null);
            const discardedValue = discardedValueByPlayerId.get(p.playerId) ?? null;
            const enteredByAdmin = enteredByAdminByPlayerId.get(p.playerId) ?? false;
            const isBrewer = brewerId === p.playerId && !provisional;
            const rerollChain = recap
              ? buildRerollChain(p.playerId, recap.layers, recap.layerParticipants)
              : [];
            const resolverRow = recapModel?.rows.find((r) => r.playerId === p.playerId) ?? null;
            const shownBadge = resolverRow ? (resolverRow.badgeValue ?? "—") : "?";

            return (
              <li key={p.playerId} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <ModifierBreakdown playerId={p.playerId} roomId={roomId} modifier={p.modifier} />
                  <div
                    className={`flex min-w-0 flex-1 flex-col gap-y-0.5 sm:flex-row sm:items-center sm:gap-x-2 ${
                      hasRecap ? "cursor-pointer" : ""
                    }`}
                    onClick={hasRecap ? () => scrollToRecapPlayer(p.playerId) : undefined}
                    title={hasRecap ? "Jump to this player's Recap steps" : undefined}
                  >
                    <span className="font-body text-sm text-parchment" title={p.displayName ?? p.email}>
                      {firstNameOrFallback(p.displayName, p.email)}
                    </span>
                    {enteredByAdmin ? (
                      <span
                        className="w-fit rounded-sm border border-gilt-dark px-1 font-display text-[9px] uppercase tracking-widest text-parchment-dim"
                        title="Entered by an admin on this player's behalf"
                      >
                        Proxy
                      </span>
                    ) : null}
                    {resolverRow ? (
                      <RollRowExpression row={resolverRow} />
                    ) : value !== null ? (
                      <span className="flex items-center gap-1 font-mono text-sm text-parchment-dim">
                        <DieIcon shape="d20" value={value} className="h-5 w-5" />
                        {discardedValue !== null ? (
                          <span className="text-parchment-dim/60 line-through">{discardedValue}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-md border-2 font-display text-sm ${
                      value === null && !resolverRow
                        ? "animate-spin border-gilt-dark text-parchment-dim"
                        : isBrewer
                          ? "border-gilt-bright bg-ember text-parchment shadow-[0_0_10px_theme(colors.gilt.DEFAULT)]"
                          : "border-gilt bg-tavern-panel-dark text-parchment"
                    }`}
                  >
                    {shownBadge}
                  </span>
                </div>

                <RerollChainRows chain={rerollChain} />
              </li>
            );
          })}
        </ul>
      </CardFrame>
    </>
  );
}
