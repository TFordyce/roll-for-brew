import Link from "next/link";

const tabClass = (isActive: boolean) =>
  `rounded-md px-4 py-2.5 font-display text-xs uppercase tracking-widest transition-colors ${
    isActive
      ? "bg-ember text-parchment shadow-[0_0_0_1px_theme(colors.gilt.dark)]"
      : "text-parchment-dim hover:bg-tavern-plank hover:text-parchment"
  }`;

export function Nav({ active }: { active: "room" | "stats" | "collection" | null }) {
  return (
    <nav className="flex gap-1 rounded-lg border-4 border-gilt bg-tavern-panel p-1 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.5)]">
      <Link href="/" className={tabClass(active === "room")}>
        Room
      </Link>
      <Link href="/stats" className={tabClass(active === "stats")}>
        Stats
      </Link>
      <Link href="/collection" className={tabClass(active === "collection")}>
        Collection
      </Link>
    </nav>
  );
}
