"use client";

/**
 * Top-right signed-in badge that doubles as sign-out: clicking the name
 * confirms, then submits the existing /auth/signout form (no new sign-out
 * mechanism — same POST target as the old standalone button).
 */
export function SignOutBadge({ name }: { name: string }) {
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
