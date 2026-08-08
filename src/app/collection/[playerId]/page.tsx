import { redirect } from "next/navigation";

/**
 * `/collection/:playerId` moved to `/:playerId/collection` (issue #212,
 * nesting the collection under the new `/:playerId` profile page). This
 * thin route forwards any old bookmark/link to the new path instead of
 * dead-ending — see `src/app/[playerId]/collection/page.tsx` for the real
 * page.
 */
export default async function PlayerCollectionRedirect({
  params,
}: {
  params: Promise<{ playerId: string }>;
}) {
  const { playerId } = await params;
  redirect(`/${playerId}/collection`);
}
