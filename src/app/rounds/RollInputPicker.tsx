import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { InAppRollForm, ManualRollForm } from "@/app/rounds/RollForms";
import { RollBothPicker } from "@/app/rounds/RollBothPicker";

export function RollInputPicker({
  mode,
  roundId,
  onRollSubmitted,
}: {
  mode: RollInputMode;
  roundId: string;
  onRollSubmitted?: () => void;
}) {
  switch (mode) {
    case "in_app_only":
      return <InAppRollForm roundId={roundId} onRollSubmitted={onRollSubmitted} />;
    case "manual_only":
      return <ManualRollForm roundId={roundId} />;
    case "both":
      return (
        <RollBothPicker key={roundId} roundId={roundId} onRollSubmitted={onRollSubmitted} />
      );
  }
}
