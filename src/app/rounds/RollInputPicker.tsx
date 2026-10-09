import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { InAppRollForm, ManualRollForm } from "@/app/rounds/RollForms";
import { RollBothPicker } from "@/app/rounds/RollBothPicker";

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
