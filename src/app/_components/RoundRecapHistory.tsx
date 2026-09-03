"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getRoundRecap } from "@/lib/supabase/roundRecap";
import { buildRoundRecap, type RoundRecapModel } from "@/lib/game/roundRecap";
import type { ScrappedGeneration } from "@/lib/supabase/roundRecap";
import { CardFrame } from "@/app/_components/CardFrame";
import { RoundRecap } from "@/app/_components/RoundRecap";
import { ScrappedGenerationDisclosure } from "@/app/_components/ScrappedGenerationDisclosure";

/**
 * Room history (issue #314): every resolved round of the current room as a
 * collapsed one-line summary that expands to its full ledger inline, drawn by
 * the same RoundRecap renderer. The Trace is fetched lazily on first expand
 * (participant-gated — rounds the viewer sat out show "no recap available").
 */

export type RoundRecapHistoryEntry = {
  roundId: string;
  resolvedAt: string;
  cupsMade: number;
  brewerName: string;
};

type RowState = "idle" | "loading" | "error" | "empty" | "ready";

function HistoryRow({
  entry,
  displayName,
  roster,
}: {
  entry: RoundRecapHistoryEntry;
  displayName: (playerId: string) => string;
  roster: string[];
}) {
  const [state, setState] = useState<RowState>("idle");
  const [model, setModel] = useState<RoundRecapModel | null>(null);
  const [scrappedGenerations, setScrappedGenerations] = useState<ScrappedGeneration[]>([]);

  async function onToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.open || state !== "idle") return;
    setState("loading");
    try {
      const data = await getRoundRecap(createClient(), entry.roundId);
      if (!data) {
        setState("error");
        return;
      }
      const built = buildRoundRecap({ data, displayName });
      setModel(built);
      setScrappedGenerations(data.scrappedGenerations);
      // A replayed round with no generation-1 casts still has a scrapped
      // attempt to show — "ready" whenever there is anything to render.
      setState(built.hasContent || data.scrappedGenerations.length > 0 ? "ready" : "empty");
    } catch {
      setState("error");
    }
  }

  const when = new Date(entry.resolvedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <details onToggle={onToggle} className="border-b border-gilt-dark/30 py-1.5 last:border-b-0">
      <summary className="cursor-pointer font-body text-xs text-parchment-dim marker:text-gilt-dark">
        <span className="text-parchment">{when}</span> · {entry.brewerName} brewed {entry.cupsMade}
      </summary>
      <div className="mt-2">
        {state === "loading" ? (
          <p className="font-body text-[11px] text-parchment-dim">Loading the ledger…</p>
        ) : null}
        {state === "error" ? (
          <p className="font-body text-[11px] text-parchment-dim">No recap available for this round.</p>
        ) : null}
        {state === "empty" ? (
          <p className="font-body text-[11px] text-parchment-dim">No spells were cast this round.</p>
        ) : null}
        {state === "ready" ? (
          <>
            <ScrappedGenerationDisclosure
              generations={scrappedGenerations}
              roster={roster}
              displayName={displayName}
            />
            {model?.hasContent ? <RoundRecap model={model} /> : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

export function RoundRecapHistory({
  entries,
  namesByPlayerId,
}: {
  entries: RoundRecapHistoryEntry[];
  namesByPlayerId: Record<string, string>;
}) {
  if (entries.length === 0) return null;
  const displayName = (playerId: string) => namesByPlayerId[playerId] ?? playerId;
  const roster = Object.keys(namesByPlayerId);

  return (
    <section className="w-full max-w-md">
      <CardFrame title="Round History">
        <div>
          {entries.map((entry) => (
            <HistoryRow key={entry.roundId} entry={entry} displayName={displayName} roster={roster} />
          ))}
        </div>
      </CardFrame>
    </section>
  );
}
