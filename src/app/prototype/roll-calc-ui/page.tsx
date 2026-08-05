import { Suspense } from "react";
import { notFound } from "next/navigation";
import { RollCalculationVariants } from "./RollCalculationVariants";

/**
 * PROTOTYPE — throwaway. Static, unauthenticated stand-in for "what should
 * the roll+modifier calculation UI look like when a spell has changed the
 * roll or the modifier" (follow-up to RollCalculation, issue #99), modelled
 * on /preview's approach (src/app/preview/page.tsx): renders no live data
 * and calls no Supabase client, so there's nothing here for middleware, RLS,
 * or admin-mode to gate. Hard-404s outside a local dev server — Vercel sets
 * VERCEL for every one of its environments (production, preview, even
 * `vercel dev`), so this route is inert the moment it's actually deployed.
 *
 * See RollCalculationVariants.tsx for the three variants and fixtures.
 */
export default function RollCalcUiPrototypePage() {
  if (process.env.VERCEL) {
    notFound();
  }

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Prototype: Roll Calculation UI
      </h1>
      <p className="max-w-md text-center font-body text-sm text-parchment-dim">
        Fixture data only — nothing here is a live round. Use the switcher at the bottom (or ←/→) to flip between
        variants A/B/C.
      </p>
      <section className="w-full max-w-md">
        {/* useSearchParams needs a Suspense boundary in the app router */}
        <Suspense fallback={null}>
          <RollCalculationVariants />
        </Suspense>
      </section>
    </main>
  );
}
