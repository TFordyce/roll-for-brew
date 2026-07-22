import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { InAppRollForm, ManualRollForm } from "@/app/rounds/RollForms";
import { RollBothPicker } from "@/app/rounds/RollBothPicker";

/** Renders the roll input matching a player's roll_input_mode (#22) — shared by the plain layer-0 roll (page.tsx) and the tie-phase reroll (TieBanner), which both switch on the same mode. */
export function RollInputPicker({ mode, roundId }: { mode: RollInputMode; roundId: string }) {
  switch (mode) {
    case "in_app_only":
      return <InAppRollForm roundId={roundId} />;
    case "manual_only":
      return <ManualRollForm roundId={roundId} />;
    case "both":
      return <RollBothPicker key={roundId} roundId={roundId} />;
  }
}
