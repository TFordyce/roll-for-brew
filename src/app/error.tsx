"use client";

/**
 * Root error boundary (there wasn't one before) — catches anything that
 * still slips through as a raw crash rather than a stale-state message the
 * page already handles gracefully, and gives the player a way back to the
 * room's current state instead of a dead end.
 */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-500">
        The room may have moved on since this page loaded.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
      >
        Try again
      </button>
    </main>
  );
}
