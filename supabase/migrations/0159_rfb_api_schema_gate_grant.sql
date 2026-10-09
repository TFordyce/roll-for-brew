-- rfb_api may read the migration history (spec #533, slice 0a deploy gate; found on first deploy, #534).
--
-- The API's /health/ready schema gate runs `select ... from supabase_migrations.schema_migrations`
-- as rfb_api. Migration 0157 granted rfb_api nothing outside `public`, so every check failed with
-- 42501 "permission denied for schema supabase_migrations" and the Cloud Run startup probe never
-- passed. Read-only: usage on the schema and select on the one table, nothing else.
--
-- Guarded because the schema is created by the Supabase CLI / hosted platform, not by this repo.

do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    grant usage on schema supabase_migrations to rfb_api;
    grant select on supabase_migrations.schema_migrations to rfb_api;
  end if;
end
$$;
