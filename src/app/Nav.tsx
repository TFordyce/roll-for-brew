import Link from "next/link";

const tabClass = (isActive: boolean) =>
  `rounded-md px-4 py-2.5 font-display text-xs uppercase tracking-widest transition-colors ${
    isActive
      ? "bg-ember text-parchment shadow-[0_0_0_1px_theme(colors.gilt.dark)]"
      : "text-parchment-dim hover:bg-tavern-plank hover:text-parchment"
  }`;

/**
 * Top-level tab nav (issue #23) — Room and Stats. Each page checks its own
 * auth and renders this itself (mirroring how each page independently
 * redirects to /login), rather than living in the root layout. Carries its
 * own gilt-bordered/tavern-panel background (issue #78, same treatment as
 * CardFrame) so it reads as part of the tabletop UI on its own, independent
 * of whatever backdrop the page it sits on has.
 */
export function Nav({ active }: { active: "room" | "stats" }) {
  return (
    <nav className="flex gap-1 rounded-lg border-4 border-gilt bg-tavern-panel p-1 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.5)]">
      <Link href="/" className={tabClass(active === "room")}>
        Room
      </Link>
      <Link href="/stats" className={tabClass(active === "stats")}>
        Stats
      </Link>
    </nav>
  );
}
