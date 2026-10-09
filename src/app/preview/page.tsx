import { notFound } from "next/navigation";
import { PreviewRoom } from "./PreviewRoom";

export default function PreviewPage() {
  if (process.env.VERCEL) {
    notFound();
  }

  return <PreviewRoom />;
}
