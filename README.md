# Okia AI Video Generator

Okia AI Video Generator is a production-oriented AI video generation application foundation built with React, TypeScript, Vite, and Supabase-ready architecture.

## Overview

This project includes:

- A polished dark-mode creator dashboard
- Auth screens using Supabase Auth
- Project management and recent generation history
- A production-ready UI for video generation jobs
- A provider abstraction for Wan 2.2-compatible GPU services
- A dev adapter that simulates job lifecycle without exposing secrets
- Database migration SQL for Supabase with RLS

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
2. Copy `.env.example` to `.env` and fill in the values for your environment.
3. Start the app:
   ```bash
   npm run dev
   ```
4. Open the local URL shown by Vite.

## Supabase setup

1. Create a Supabase project.
2. Enable Authentication > Email sign-in.
3. Run the SQL migration in `supabase/migrations/001_init_schema.sql`.
4. Add your project URL and anon key to the frontend env vars.
5. Store the service role key only on the server or in a deployment secret.

## Vercel deployment

1. Import the repository into Vercel.
2. Set the same env vars in the Vercel project settings.
3. Ensure the app builds with:
   ```bash
   npm run build
   ```
4. Deploy the production build.

## Wan 2.2 integration

This project includes a server-side boundary in `api/wan22.ts` for a Wan 2.2-compatible GPU worker. The app does not claim a working Wan 2.2 deployment unless `WAN22_API_URL` and `WAN22_API_KEY` are configured on the server.

When these values are missing, the app automatically uses a development adapter that simulates status transitions and never presents generated video as real AI output.

## Security notes

- Do not place `SUPABASE_SERVICE_ROLE_KEY` or `WAN22_API_KEY` in a Vite `VITE_` variable.
- Keep all privileged secrets server-side only.
- Use Supabase Row Level Security to restrict access to user-owned jobs and project data.

## Manual configuration checklist

- Supabase project and auth enabled
- RLS migration applied
- Storage bucket created for private generated videos
- GPU provider endpoint configured for real generation
- Vercel environment variables set
- Optional billing or credit system implemented separately if needed

## Known limitations

- Real GPU generation requires a valid Wan 2.2-compatible endpoint and credentials.
- The app is a functional foundation and not a full paid credit system.
- File storage, provider retries, and queue reconciliation need the external infrastructure configured.
