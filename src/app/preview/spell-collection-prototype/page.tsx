import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CollectionPrototype } from "./CollectionPrototype";

/**
 * PROTOTYPE — ticket #124 (Spell Collection page: visual design &
 * entry-point prototype). Static, unauthenticated stand-in, same
 * hard-404-off-Vercel convention as /preview (src/app/preview/page.tsx):
 * inert the moment it's actually deployed anywhere.
 */
export default function SpellCollectionPrototypePage() {
  if (process.env.VERCEL) {
    notFound();
  }

  return (
    <Suspense>
      <CollectionPrototype />
    </Suspense>
  );
}
