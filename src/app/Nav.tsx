import Link from "next/link";

/**
 * Top-level tab nav (issue #23) — Room and Stats. Each page checks its own
 * auth and renders this itself (mirroring how each page independently
 * redirects to /login), rather than living in the root layout.
 */
export function Nav({ active }: { active: "room" | "stats" }) {
  return (
    <nav className="flex gap-4 text-sm">
      <Link href="/" className={active === "room" ? "font-semibold underline" : "text-neutral-500"}>
        Room
      </Link>
      <Link
        href="/stats"
        className={active === "stats" ? "font-semibold underline" : "text-neutral-500"}
      >
        Stats
      </Link>
    </nav>
  );
}
