"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PixelStar } from "@/app/_components/PixelStar";
import { rateSpellCard, withdrawSpellCardRating } from "@/lib/supabase/spellCardRatings";

export function SpellCardRatingRow({
  cardId,
  myRating,
  isCastEligible,
}: {
  cardId: string;
  myRating: number | null;
  isCastEligible: boolean;
}) {
  const [committedScore, setCommittedScore] = useState<number | null>(myRating);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (committedScore === null && !isCastEligible) return null;

  const readOnly = !isCastEligible;

  async function pickStar(n: number) {
    if (pending || readOnly) return;
    setPending(true);
    setError(null);
    const supabase = createClient();
    const withdrawing = n === committedScore;
    try {
      if (withdrawing) {
        await withdrawSpellCardRating(supabase, cardId);
        setCommittedScore(null);
      } else {
        await rateSpellCard(supabase, cardId, n);
        setCommittedScore(n);
      }
    } catch {
      setError(withdrawing ? "Couldn't withdraw — try again." : "Couldn't save — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3">
      <p className="mb-1 font-display text-[10px] uppercase tracking-widest text-parchment-dim">
        {readOnly ? "Your rating" : "Rate this spell"}
      </p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
            aria-pressed={committedScore !== null && n <= committedScore}
            onClick={() => pickStar(n)}
            disabled={pending || readOnly}
            className="p-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <PixelStar lit={committedScore !== null && n <= committedScore} />
          </button>
        ))}
      </div>
      {error ? <p className="mt-1 text-[11px] text-ember-bright">{error}</p> : null}
    </div>
  );
}
