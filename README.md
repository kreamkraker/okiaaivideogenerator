# Okia AI Video Generator

Okia AI Video Generator is a React, TypeScript, and Vite application foundation with Supabase authentication and a server-side provider adapter.

## Overview

This project includes:

- A polished dark-mode creator dashboard
- Auth screens using Supabase Auth
- Project management and recent generation history
- A video-generation dashboard with in-memory sample data
- A development adapter that simulates job lifecycle
- A Vercel API route that validates Supabase sessions and proxies to the configured provider
- A Supabase schema migration with row-level ownership policies, an idempotency key, a rate limit, and server-side credit ledger operations
- Authenticated API endpoints for generation history and ledger balance

## Stack

- Frontend: React + TypeScript + Vite
- Auth and data: Supabase
- Deployment target: Vercel
- AI provider boundary: Wan 2.2-compatible GPU service via server-side API route

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env`. Leave `VITE_WAN22_MODE=development` and `WAN22_PROVIDER_CONTRACT_CONFIRMED=false` until the provider contract and pricing are verified.
3. Start the app:
   ```bash
   npm run dev
   ```
4. Open the local URL shown by Vite.

## Supabase setup

1. Create a Supabase project.
2. Enable Authentication > Email sign-in.
3. Apply the SQL migrations in `supabase/migrations/` in filename order.
4. Add your project URL and anon key to the frontend env vars.
5. Add the same Supabase URL and public anon/publishable key to the server environment for API token validation.
6. Store `SUPABASE_SERVICE_ROLE_KEY` only in the server environment. The API uses it to persist and owner-scope provider jobs.

## Vercel deployment

1. Import the repository into Vercel.
2. Configure the `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (or publishable key), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` values. Configure WAN values only after the actual worker contract and pricing have been verified. Never prefix server secrets with `VITE_`.
3. Vercel detects `api/wan22.ts` as a serverless function; no custom `vercel.json` is required for this layout.
4. Ensure the app builds with:
   ```bash
   npm run build
   ```
5. Deploy only after the external provider contract, credentials, Supabase migration, and policies have been verified in your own environment.

## Wan 2.2 integration

The server-side adapter uses the existing project's `/jobs` and `/jobs/{id}` route conventions, JSON payload, `providerJobId`, `status`, `progress`, and `outputUrl` response fields, and a Bearer authorization header. These conventions have not been verified against a real GPU worker; confirm them against the worker's documentation before enabling real generation.

Real-mode requests require a valid Supabase access token, server-side provider URL/key, Supabase public credentials, and server-side service-role key. Generation also remains disabled unless `WAN22_PROVIDER_CONTRACT_CONFIRMED=true` and a positive `WAN22_GENERATION_CREDIT_COST` are configured. Set those only after independently verifying the worker contract and provider pricing. Development mode does not contact the WAN route or generate real video. The project has not been verified against configured external services.
Use `VITE_WAN22_MODE=production` only after confirming the provider contract and pricing and configuring all required server environment values.

## Hugging Face WAN 2.2 Space (opt-in)

The optional Hugging Face adapter uses the verified Gradio API for the public `makiblek/Wan_2.2_I2V_14B_Custom_Lora_Wow` Space. It is disabled by default. For a controlled local test, set `VITE_WAN22_MODE=huggingface` in the frontend build environment and set `WAN22_PROVIDER=huggingface`, `HF_SPACE_PROVIDER_ENABLED=true`, `HF_TOKEN`, and a positive `WAN22_GENERATION_CREDIT_COST` in the server environment. Keep the Hugging Face token server-side; never use a `VITE_` prefix for it. Supabase authentication, ownership, rate limiting, credit reservations, and failed-job refunds continue to apply.

This provider supports image-to-video only and accepts images up to 3 MB. A request transfers the image and prompt to a community Space. Queue capacity, uptime, authentication access, and any free ZeroGPU allowance are not guaranteed; usage may be limited by Hugging Face quotas or account terms. The adapter does not store generated output in Supabase. Space-hosted video links may be temporary, so download successful outputs promptly. No live generation has been run as part of this integration.

## Security notes

- Do not place `SUPABASE_SERVICE_ROLE_KEY` or `WAN22_API_KEY` in a Vite `VITE_` variable.
- Do not place `HF_TOKEN` in a Vite `VITE_` variable.
- Keep all privileged secrets server-side only.
- Use Supabase Row Level Security to restrict access to user-owned jobs and project data.

## Manual configuration checklist

- Supabase project and auth enabled
- RLS migration applied
- Storage bucket created for private generated videos
- GPU provider endpoint and exact request/auth/response contract verified
- Vercel environment variables set
- Optional billing or credit system implemented separately if needed
- Supabase sign-in account created; the dashboard offers Supabase password sign-in when configured

## Known limitations

- Real GPU generation requires a verified Wan 2.2-compatible endpoint, credentials, and matching provider contract.
- The credit ledger and generation reservation/refund operations are implemented in SQL but require migration application and a trusted way to grant initial credits; payments are not implemented.
- Demo projects and sample dashboard jobs are local illustrative data. Authenticated history and credit balance use server-side Supabase API operations.
- Generated-video rows retain the provider output URL; durable private object storage, provider retries, and outcome reconciliation require further infrastructure and implementation.
- `npm run dev` starts Vite only; use the Vercel CLI's `vercel dev` to exercise the `api/` function locally.
