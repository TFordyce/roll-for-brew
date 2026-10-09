namespace RollForBrew.Tests.Harness;

public static class SupabaseStubs
{
    public const string Sql = """
        do $$
        begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
        end $$;

        create schema if not exists auth;
        create table auth.users (
          id uuid primary key,
          email text,
          raw_user_meta_data jsonb not null default '{}'::jsonb
        );
        -- Same contract as Supabase: the sub claim of request.jwt.claims.
        create function auth.uid() returns uuid language sql stable as $f$
          select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
        $f$;
        grant usage on schema auth to anon, authenticated, service_role;
        """;
}
