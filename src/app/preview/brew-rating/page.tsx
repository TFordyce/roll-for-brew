import { notFound } from "next/navigation";
import { BrewRatingPreview } from "./BrewRatingPreview";

/**
 * PROTOTYPE — throwaway. Answers "what should the Brew Rating slide-out
 * panel look/feel like?" for the wayfinder ticket "Prototype: Rating panel
 * (16-bit notepad + star toggle)" (issue #202, part of Map: Brew Rating
 * system, issue #201). Same pattern as /preview: static, unauthenticated,
 * no Supabase, hard-404s outside local dev (Vercel sets VERCEL in every
 * one of its environments, so this route is inert once deployed).
 *
 * Three structurally different takes on the panel, switchable via
 * ?variant=A|B|C, plus a data-state switcher (?state=none|pending|rated)
 * for the three things the panel needs to communicate. Not final code —
 * capture the winner into the real component, drop this route.
 */
export default function BrewRatingPreviewPage() {
  if (process.env.VERCEL) {
    notFound();
  }

  return <BrewRatingPreview />;
}
