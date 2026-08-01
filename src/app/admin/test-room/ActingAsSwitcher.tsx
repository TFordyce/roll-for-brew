import { setActingAsAction } from "@/app/admin/test-room/actions";
import { CardFrame } from "@/app/_components/CardFrame";

export type ActingAsOption = {
  playerId: string;
  displayName: string | null;
  email: string;
  isSelf: boolean;
};

/**
 * Lists every Test Player plus the admin's own real identity (issue #102),
 * highlights whichever one the caller is currently Acting As, and switches
 * on selection. Purely a client-facing menu — the actual resolution (and
 * the "only inside the Test Room" safety property) is enforced entirely
 * server-side by current_player_id()/set_acting_as; this component can't
 * itself make puppeting take effect anywhere else.
 */
export function ActingAsSwitcher({
  options,
  currentPlayerId,
}: {
  options: ActingAsOption[];
  currentPlayerId: string;
}) {
  return (
    <CardFrame title="Acting As">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
        {options.map((option) => {
          const isCurrent = option.playerId === currentPlayerId;
          return (
            <form key={option.playerId} action={setActingAsAction}>
              <input type="hidden" name="targetPlayerId" value={option.playerId} />
              <button
                type="submit"
                disabled={isCurrent}
                className={
                  isCurrent
                    ? "w-full rounded-md border-2 border-gilt-bright bg-ember px-3 py-2 font-display text-xs uppercase tracking-widest text-parchment"
                    : "w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-3 py-2 font-display text-xs uppercase tracking-widest text-parchment hover:border-gilt"
                }
              >
                {option.displayName ?? option.email}
                {option.isSelf ? " (you)" : ""}
              </button>
            </form>
          );
        })}
      </div>
    </CardFrame>
  );
}
