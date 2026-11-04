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

        -- Same shape as Supabase: a committed insert is what gets delivered, so a row here
        -- means "delivered on commit". rfb_api gets no usage, as on hosted.
        create schema if not exists realtime;
        create table realtime.messages (
          seq bigint generated always as identity primary key,
          topic text not null,
          event text not null,
          payload jsonb not null,
          private boolean not null
        );
        create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
        returns void language plpgsql as $f$
        begin
          insert into realtime.messages (topic, event, payload, private) values (topic, event, payload, private);
        end $f$;
        """;
}
