import { submitManualRollAction, submitRollAction } from "@/app/rounds/actions";

/** The in-app (server-generated) roll form — shared by the in_app_only branch and RollBothPicker's 'both' choice. */
export function InAppRollForm({ roundId }: { roundId: string }) {
  return (
    <form action={submitRollAction} className="mt-3">
      <input type="hidden" name="roundId" value={roundId} />
      <button
        type="submit"
        className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
      >
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
        className="w-16 rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 font-mono text-sm text-parchment focus:border-gilt focus:outline-none"
      />
      <button
        type="submit"
        className="flex-1 rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
      >
        Submit
      </button>
    </form>
  );
}
