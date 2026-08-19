"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Top-right signed-in badge. For everyone (the common case, `showAdminMenu`
 * false), clicking the name confirms then submits the existing
 * /auth/signout form — unchanged behavior. For a qualifying admin
 * (canAccessTestRoom true — see src/lib/game/testRoomAccess.ts), clicking
 * instead opens a small menu with "Admin" (-> /admin/test-room) and "Sign
 * out" (today's confirm+submit flow), so sign-out no longer fires
 * immediately for that one case.
 */
export function SignOutBadge({ name, showAdminMenu = false }: { name: string; showAdminMenu?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (!showAdminMenu) {
    return (
      <form
        action="/auth/signout"
        method="post"
        onSubmit={(event) => {
          if (!confirm("Sign out?")) {
            event.preventDefault();
          }
        }}
        className="absolute right-4 top-4"
      >
        <button
          type="submit"
          className="rounded-md bg-parchment/90 px-3 py-1.5 font-display text-xs uppercase tracking-widest text-tavern-panel hover:bg-parchment"
        >
          {name}
        </button>
      </form>
    );
  }

  return (
    <div className="absolute right-4 top-4 flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        className="rounded-md bg-parchment/90 px-3 py-1.5 font-display text-xs uppercase tracking-widest text-tavern-panel hover:bg-parchment"
      >
        {name}
      </button>

      {menuOpen ? (
        <div className="flex flex-col gap-1 rounded-md border-2 border-gilt-dark bg-tavern-panel-dark p-2">
          <Link
            href="/admin/test-room"
            className="rounded-md px-3 py-1.5 text-right font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember/40"
          >
            Admin
          </Link>
          <Link
            href="/admin/cards"
            className="rounded-md px-3 py-1.5 text-right font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember/40"
          >
            Allocate Cards
          </Link>
          <Link
            href="/admin/proxy-roll"
            className="rounded-md px-3 py-1.5 text-right font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember/40"
          >
            Proxy Roll
          </Link>
          <form
            action="/auth/signout"
            method="post"
            onSubmit={(event) => {
              if (!confirm("Sign out?")) {
                event.preventDefault();
              }
            }}
          >
            <button
              type="submit"
              className="w-full rounded-md px-3 py-1.5 text-right font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember/40"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
