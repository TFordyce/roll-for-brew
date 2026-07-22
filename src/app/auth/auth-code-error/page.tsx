export default function AuthCodeErrorPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Couldn&apos;t sign you in</h1>
      <p className="max-w-md text-sm text-neutral-500">
        Either something went wrong, or this Google account isn&apos;t on the
        Roll for Brew whitelist. If you think you should have access, ask
        whoever maintains the whitelist to add you.
      </p>
      <a href="/login" className="text-sm underline">
        Back to login
      </a>
    </main>
  );
}
