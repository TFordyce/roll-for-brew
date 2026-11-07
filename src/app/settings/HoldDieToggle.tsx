"use client";

import { setHoldOwnDieUntilRevealAction } from "@/app/settings/actions";
import { SubmitButton } from "@/app/_components/SubmitButton";

export function HoldDieToggle({ held }: { held: boolean }) {
  return (
    <form action={setHoldOwnDieUntilRevealAction}>
      <input type="hidden" name="holdOwnDie" value={held ? "false" : "true"} />
      <SubmitButton className="w-full rounded-md border-2 border-gilt bg-tavern-panel-dark px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember/40 disabled:cursor-not-allowed disabled:border-gilt-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
        My die: {held ? "Waits for the reveal" : "Lands early"}
      </SubmitButton>
    </form>
  );
}
