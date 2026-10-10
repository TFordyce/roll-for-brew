import type { AllocateSpellCardState } from "./actions";
import type { RealPlayer } from "@/lib/supabase/players";

const CHOICE_CLASS =
  "rounded-md border-2 border-gilt-dark bg-transparent px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment disabled:cursor-not-allowed";

export function MarkWarning({
  cardId,
  warning,
  players,
  formAction,
  isPending,
}: {
  cardId: string;
  warning: Extract<AllocateSpellCardState, { status: "mark_warning" }>;
  players: RealPlayer[];
  formAction: (formData: FormData) => void;
  isPending: boolean;
}) {
  const nameOf = (id: string) => {
    const player = players.find((p) => p.id === id);
    return player ? (player.displayName ?? player.email) : null;
  };

  return (
    <form action={formAction} role="alert" className="flex flex-col gap-1">
      <input type="hidden" name="cardId" value={cardId} />
      <input type="hidden" name="playerId" value={warning.playerId} />
      <p className="font-body text-xs text-amber-400">{warning.message}</p>
      <div className="flex flex-wrap gap-1">
        <button type="submit" name="markChoice" value="target" disabled={isPending} className={CHOICE_CLASS}>
          Give to {nameOf(warning.playerId) ?? "the target"} anyway
        </button>
        <button type="submit" name="markChoice" value="beneficiary" disabled={isPending} className={CHOICE_CLASS}>
          Give to {nameOf(warning.beneficiaryId) ?? "the marker"}
        </button>
        <button type="submit" name="markChoice" value="cancel" disabled={isPending} className={CHOICE_CLASS}>
          Cancel
        </button>
      </div>
    </form>
  );
}
