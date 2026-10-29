# Supabase setup

This project uses Supabase Auth for sign-in and the Supabase database for
authenticated generation history and credit records. The browser uses only the
public project URL and anon/publishable key. Privileged database operations are
performed by `api/wan22.ts` with a server-side service-role key.

## Environment variables

Copy the safe placeholders from the repository's `.env.example` when configuring
local development. Set frontend variables in the Vite build environment:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` or `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_WAN22_MODE=development` to keep generation in demo mode

For Vercel server functions, configure the corresponding Supabase project URL
and public key as `SUPABASE_URL` and `SUPABASE_ANON_KEY`, and configure
`SUPABASE_SERVICE_ROLE_KEY` as a server-only secret. The handler also supports
the documented Vite URL/public-key fallbacks, but privileged keys must never
use a `VITE_` prefix. Do not copy real credentials into source files or commit
local `.env` files.

WAN and Hugging Face configuration is separate from Supabase. Keep `HF_TOKEN`
and `WAN22_API_KEY` server-side. Real generation remains disabled until its
provider is explicitly configured and its contract and pricing are verified.

## Migration workflow

Review the SQL files in `migrations/` in filename order before applying them.
Check that the target project's existing schema and migration history are
compatible; these files have not been applied to any live project as part of
this repository work.

Use a disposable local Supabase project or a separately authorized test project
to validate changes first. Back up any database before applying reviewed
migrations. Apply them only through an authorized Supabase SQL Editor or the
Supabase CLI after confirming the project and environment. Do not apply local
migrations to production as part of a build or deployment.

## Schema and row-level security

`migrations/001_init_schema.sql` defines profiles, projects, generation jobs,
generated-video metadata, usage records, credit transactions, and rate-limit
records. It enables row-level security. Authenticated users can access only
their own profile and projects; private generation, usage, and credit records
are read-only to their owner. Server-only operations use the service role and
restricted database functions for rate limits, credit reservations/refunds,
and balance lookup.

`migrations/002_huggingface_provider.sql` updates the allowed provider value on
generation jobs. It does not configure credentials or enable a provider.

The database policies and functions in these files have not been tested against
the live Supabase project. Verify them against the project's actual PostgreSQL
version and migration history before applying anything.

## Deployment

Vercel builds the frontend with the `VITE_SUPABASE_*` public values and runs
`api/wan22.ts` as a serverless function. Configure server-only Supabase values
in the Vercel project environment separately; do not expose the service-role
key to the browser. Review the root `README.md` for the overall build and
provider configuration checklist. A successful frontend build does not verify
database connectivity, authentication settings, RLS behavior, or generation.

## Storage limitation

The schema can record a provider URL or storage path, but the current API does
not copy generated videos into Supabase Storage or create a bucket and storage
policies. Hugging Face output links may expire. Do not treat them as durable
private downloads.
