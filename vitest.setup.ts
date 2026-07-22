import { config } from "dotenv";

// Tests read SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY from
// .env.test (gitignored) so a local test-project key never has to be
// exported by hand or committed anywhere.
config({ path: ".env.test" });
