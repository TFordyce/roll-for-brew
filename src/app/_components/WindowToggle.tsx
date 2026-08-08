import Link from "next/link";
import type { StatsWindow } from "@/lib/supabase/stats";

/**
 * All-time / last-30-days toggle driven by the shared `?window=` search
 * param — originally `/stats`' own leaderboards (issue #79), now reused
 * as-is by the `/[playerId]` profile page's Player Stats card (issue #212)
 * against a different `basePath`. `extraQuery` carries any other search
 * params a page needs preserved across the toggle (`/stats`' `&room=`).
 */
export function WindowToggle({
  window,
  basePath,
  extraQuery = "",
}: {
  window: StatsWindow;
  basePath: string;
  extraQuery?: string;
}) {
  return (
    <div className="flex gap-3 font-display text-xs uppercase tracking-widest">
      <Link
        href={`${basePath}?window=all_time${extraQuery}`}
        className={window === "all_time" ? "text-gilt-bright" : "text-parchment-dim"}
      >
        All-time
      </Link>
      <Link
        href={`${basePath}?window=last_30_days${extraQuery}`}
        className={window === "last_30_days" ? "text-gilt-bright" : "text-parchment-dim"}
      >
        Last 30 days
      </Link>
    </div>
  );
}
