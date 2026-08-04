#!/usr/bin/env node
// Adds an email to public.whitelist via the Supabase REST API, using the
// service-role key (the only credential that can write to that table — it's
// RLS-locked with zero policies, see README.md "Auth: Google OAuth +
// whitelist gate").
//
// Setup (one-time): add SUPABASE_SERVICE_ROLE_KEY to .env.local (Supabase
// dashboard -> Project Settings -> API -> service_role secret). Never commit
// this key — it bypasses RLS on the whole project. NEXT_PUBLIC_SUPABASE_URL
// is already in .env.local from the app setup.
//
// Usage:
//   npm run whitelist:add -- someone@example.com [another@example.com ...]

import { config } from "dotenv";
config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const emails = process.argv.slice(2).map((e) => e.trim().toLowerCase());

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Add SUPABASE_SERVICE_ROLE_KEY to .env.local (Supabase dashboard -> Project Settings -> API)."
  );
  process.exit(1);
}

if (emails.length === 0) {
  console.error("Usage: npm run whitelist:add -- someone@example.com [another@example.com ...]");
  process.exit(1);
}

const invalid = emails.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
if (invalid.length > 0) {
  console.error(`Not a valid email: ${invalid.join(", ")}`);
  process.exit(1);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/whitelist`, {
  method: "POST",
  headers: {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "resolution=ignore-duplicates,return=representation",
  },
  body: JSON.stringify(emails.map((email) => ({ email }))),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Failed (${res.status}): ${body}`);
  process.exit(1);
}

const inserted = await res.json();
const insertedEmails = new Set(inserted.map((row) => row.email));

for (const email of emails) {
  console.log(insertedEmails.has(email) ? `✅ added ${email}` : `⏭️  ${email} already whitelisted`);
}
