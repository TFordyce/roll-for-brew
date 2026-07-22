import { submitManualRollAction, submitRollAction } from "@/app/rounds/actions";

/** The in-app (server-generated) roll form — shared by the in_app_only branch and RollBothPicker's 'both' choice. */
export function InAppRollForm({ roundId }: { roundId: string }) {
  return (
    <form action={submitRollAction} className="mt-3">
      <input type="hidden" name="roundId" value={roundId} />
      <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
        Roll
      </button>
    </form>
  );
}

/** The manual-entry roll form — shared by the manual_only branch and RollBothPicker's 'both' choice. */
export function ManualRollForm({ roundId }: { roundId: string }) {
  return (
    <form action={submitManualRollAction} className="mt-3 flex items-center gap-2">
      <input type="hidden" name="roundId" value={roundId} />
      <input
        type="number"
        name="value"
        min={1}
        max={20}
        required
        className="w-16 rounded border border-neutral-300 px-2 py-1 text-sm"
      />
      <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
        Submit
      </button>
    </form>
  );
}
