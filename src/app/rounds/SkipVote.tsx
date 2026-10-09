"use client";

import { useEffect, useState } from "react";
import { voteSkipReactionWindowAction } from "@/app/rounds/actions";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { skipVoteView, type SkipVoteState } from "@/lib/game/skipVote";

/**
 * The reaction banner's Skip vote (issue #411): the "Skip waiting" control
 * for a voter, the count for a spectator, or the "pass or react now" notice
 * for a player being waited on (see skipVoteView). Re-renders itself when the
 * 30-second grace period ends; every vote broadcasts room-changed,
 * which refreshes the counts.
 */
export function SkipVote({ roundId, state }: { roundId: string; state: SkipVoteState }) {
  const [now, setNow] = useState(() => new Date());
  const graceEndsMs = state.graceEndsAt.getTime();

  useEffect(() => {
    const wait = graceEndsMs - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(new Date()), wait);
    return () => clearTimeout(timer);
  }, [graceEndsMs]);

  const view = skipVoteView(state, now);

  switch (view.kind) {
    case "none":
      return null;
    case "notice":
      return (
        <p role="status" className="mt-2 font-body text-sm text-gilt-bright">
          The table is voting to skip. Pass or react now.
        </p>
      );
    case "count":
      return <p className="mt-2 font-body text-xs text-parchment-dim">{countText(view)}</p>;
    case "voted":
    case "vote":
      return (
        <form action={voteSkipReactionWindowAction} className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="roundId" value={roundId} />
          <SubmitButton
            disabled={view.kind === "voted"}
            className="rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark disabled:cursor-not-allowed disabled:border-gilt-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
          >
            {view.kind === "voted" ? "Voted" : "Skip waiting"}
          </SubmitButton>
          <span className="font-body text-xs text-parchment-dim">{countText(view)}</span>
        </form>
      );
  }
}

function countText({ votes, threshold }: { votes: number; threshold: number }): string {
  return `${votes} of ${threshold} votes to skip`;
}
