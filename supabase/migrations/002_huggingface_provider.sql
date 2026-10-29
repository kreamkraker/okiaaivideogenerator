alter table public.generation_jobs
  drop constraint if exists generation_jobs_provider_check;

alter table public.generation_jobs
  add constraint generation_jobs_provider_check
  check (provider in ('wan22', 'huggingface', 'development'));
