-- The "before user created" hook (0001) only runs once, when an
-- auth.users row is first created — it doesn't re-run for a returning
-- user's later logins. That leaves a gap: removing someone from
-- public.whitelist wouldn't actually revoke their access, since their
-- existing account could keep signing in and getting sessions
-- indefinitely. This hook closes that gap by checking the whitelist on
-- every token issuance (every sign-in and every token refresh), wired as
-- the "Custom Access Token" Auth Hook in supabase/config.toml. Returning
-- an error here blocks the token — and therefore the session — from
-- being issued at all, so a de-whitelisted identity is locked out on its
-- very next login attempt, not just at signup.
create or replace function public.enforce_whitelist_on_access_token(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_email text;
begin
  claim_email := lower(event -> 'claims' ->> 'email');

  if claim_email is null or not exists (
    select 1 from public.whitelist w where lower(w.email) = claim_email
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'This Google account is no longer on the Roll for Brew whitelist.'
      )
    );
  end if;

  return jsonb_build_object('claims', event -> 'claims');
end;
$$;

revoke execute on function public.enforce_whitelist_on_access_token(jsonb) from public, anon, authenticated;
grant execute on function public.enforce_whitelist_on_access_token(jsonb) to supabase_auth_admin;
