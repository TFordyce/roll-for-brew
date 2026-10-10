import Link from "next/link";
import type { StatsWindow } from "@/lib/supabase/stats";

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
