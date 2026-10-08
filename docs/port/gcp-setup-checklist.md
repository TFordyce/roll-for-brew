# GCP setup checklist for the C# API (ticket #534)

Human-only steps. Do them in order, then record the results on issue #534. Region is `europe-west1` throughout. Replace `PROJECT_ID`, `PROJECT_NUMBER`, `PROJECT_REF` (Supabase) and `TEAM` (Vercel team slug).

## 1. Project, billing, budget

- [ ] Create GCP project `PROJECT_ID`; link a billing account.
- [ ] Billing > Budgets & alerts: create a budget of GBP 1 on this project with email alerts at 50%, 90% and 100%.
- [ ] Enable APIs: `gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project PROJECT_ID`

## 2. Artifact Registry

- [ ] `gcloud artifacts repositories create rfb-api --repository-format=docker --location=europe-west1 --project PROJECT_ID`
- [ ] Cleanup policy keeping the last 5 images: save as `policy.json`
  `[{"name":"keep-last-5","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":5}}]`
  then `gcloud artifacts repositories set-cleanup-policies rfb-api --location=europe-west1 --policy=policy.json --no-dry-run`

## 3. Database role and secret

- [ ] The `rfb_api` role is created by migration 0155 (#535); set its password per `rfb-api-role-runbook.md`. Before that is live, use any working pooler connection string for the first deploy test, then replace it.
- [ ] Build the connection string for the Supavisor transaction pooler (port 6543), user `rfb_api.PROJECT_REF`, with `Max Auto Prepare=0;No Reset On Close=true;Multiplexing=false;Maximum Pool Size=5` (Npgsql keyword form: `Host=...;Port=6543;Database=postgres;Username=rfb_api.PROJECT_REF;Password=...;SSL Mode=Require;...`).
- [ ] `gcloud secrets create rfb-api-postgres-connection-string --replication-policy=automatic --project PROJECT_ID`, then add the value as a version (`gcloud secrets versions add ... --data-file=-`).

## 4. Service accounts and IAM

- [ ] Cloud Build service account (default: `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`, or the account you attach to the trigger) needs: `roles/run.admin`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` on the Cloud Run runtime service account, `roles/logging.logWriter`.
- [ ] Cloud Run runtime service account (default compute SA is fine) needs `roles/secretmanager.secretAccessor` on `rfb-api-postgres-connection-string`.

## 5. Cloud Build trigger

- [ ] Cloud Build > Triggers > Connect repository: GitHub (Cloud Build GitHub App), repo `TFordyce/roll-for-brew`, region `europe-west1` (or global, but be consistent).
- [ ] Create trigger `rfb-api-deploy`: event Push to branch `^master$`; **included files `api/**`**; configuration: Cloud Build config file `api/cloudbuild.yaml`; do NOT set a worker pool (default `e2-standard-2` is set in the file).
- [ ] Add the file's migrations dependency: the config reads `supabase/migrations/`, which is in the repo checkout regardless of the filter. Note a migrations-only merge does not trigger a build (the gate only matters for api/ merges).
- [ ] Substitutions on the trigger: `_JWKS_URL=https://PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json`, `_PROJECT_REF=PROJECT_REF`, `_CORS_ORIGINS=https://<production-origin>,https://roll-for-brew-*-TEAM.vercel.app` (check the real Vercel preview URL pattern in the Vercel dashboard first; `*` matches one host label segment run, no `/`).
- [ ] Run the trigger once manually on master. Expected: build ok, push SHA-tagged image, Cloud Run service `rfb-api` created. If the schema gate step fails the deploy retries with backoff; confirm the newest migration version is in hosted `supabase_migrations.schema_migrations` (the duplicate 0153 is tracked as #571, newest is 0154).
- [ ] Confirm Cloud Run settings: region europe-west1, min instances 0, max instances 2, startup probe `/health/ready`, env vars and secret mapped.
- [ ] Unauthenticated invoke: the deploy uses `--allow-unauthenticated` (the API validates Supabase JWTs itself). If an org policy blocks that, grant `allUsers` `roles/run.invoker` on the service, or adjust.

## 6. GitHub branch protection

Do this after `ci.yml` has run once on a PR so `ci-ok` is a known check name.

- [ ] Branch protection on `master`: require status check `ci-ok` as the only required check (strict/up-to-date optional). E.g.
  `gh api -X PUT repos/TFordyce/roll-for-brew/branches/master/protection --input protection.json` with `required_status_checks: {strict: false, contexts: ["ci-ok"]}`, `enforce_admins: false`, `required_pull_request_reviews: null`, `restrictions: null`.
- [ ] Confirm Actions has no repository or environment secrets.

## 7. Cold start measurement

- [ ] With the service scaled to zero (wait ~15 min idle), run `curl -s -o /dev/null -w '%{time_total}\n' https://<service-url>/health` 5 times, spaced 15+ min apart. Record the first-request time of each (cold) and a warm request. Do not add keep-warm.

## 8. Record on #534

- [ ] Service URL, image tag deployed, cold-start times, budget alert screenshot or confirmation, confirmation that `ci-ok` is required.
