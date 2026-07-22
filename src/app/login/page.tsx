"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setError(null);
    setIsRedirecting(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (signInError) {
      setError(signInError.message);
      setIsRedirecting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Roll for Brew</h1>
      <p className="text-sm text-neutral-500">
        Sign in with your Google account to join today&apos;s room.
      </p>
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={isRedirecting}
        className="rounded-md bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {isRedirecting ? "Redirecting…" : "Sign in with Google"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </main>
  );
}
