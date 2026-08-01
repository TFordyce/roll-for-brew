import { endTestSessionAction } from "@/app/admin/test-room/actions";

/**
 * Clears the Test Room's accumulated rounds/rolls/casts/effects (issue
 * #102), leaving the room and its seeded roster ready for next time.
 */
export function EndTestSessionButton() {
  return (
    <form action={endTestSessionAction}>
      <button
        type="submit"
        className="w-full rounded-md border-2 border-gilt px-4 py-2 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
      >
        End Test Session
      </button>
    </form>
  );
}
