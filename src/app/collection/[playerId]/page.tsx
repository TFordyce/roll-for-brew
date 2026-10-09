import { redirect } from "next/navigation";

export default async function PlayerCollectionRedirect({
  params,
}: {
  params: Promise<{ playerId: string }>;
}) {
  const { playerId } = await params;
  redirect(`/${playerId}/collection`);
}
