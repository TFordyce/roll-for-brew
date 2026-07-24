import { notFound } from "next/navigation";
import { PreviewRoom } from "./PreviewRoom";

/**
 * Static, unauthenticated stand-in for the Room page (issue: local UI
 * review without needing a real Google/Supabase session). Renders no live
 * data and calls no Supabase client, so there's nothing here for
 * middleware or RLS to gate. Hard-404s outside a local dev server: Vercel
 * sets VERCEL for every one of its environments (production, preview,
 * even `vercel dev`), so this route is inert the moment it's actually
 * deployed anywhere.
 */
export default function PreviewPage() {
  if (process.env.VERCEL) {
    notFound();
  }

  return <PreviewRoom />;
}
