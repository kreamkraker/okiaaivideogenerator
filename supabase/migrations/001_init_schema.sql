create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled project',
  description text not null default '',
  prompt text not null default '',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  provider text not null default 'wan22' check (provider in ('wan22', 'huggingface', 'development')),
  model text not null check (model in ('wan-2.2-t2v', 'wan-2.2-i2v', 'wan-2.2-fast', 'custom')),
  mode text not null check (mode in ('text-to-video', 'image-to-video')),
  prompt text not null check (length(trim(prompt)) >= 10),
  negative_prompt text,
  image_url text,
  aspect_ratio text not null check (aspect_ratio in ('16:9', '9:16', '1:1')),
  duration_seconds integer not null default 8 check (duration_seconds between 4 and 30),
  resolution text not null default '1280x720' check (resolution ~ '^[1-9][0-9]*x[1-9][0-9]*$'),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  progress integer not null default 0 check (progress between 0 and 100),
  provider_job_id text,
  provider_status text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, request_id),
  constraint generation_jobs_project_owner_fkey
    foreign key (user_id, project_id)
    references public.projects(user_id, id)
    on delete set null (project_id)
);

create table if not exists public.generated_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null,
  title text not null,
  storage_path text,
  public_url text,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  duration_seconds integer check (duration_seconds is null or duration_seconds > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (job_id),
  constraint generated_videos_job_owner_fkey
    foreign key (user_id, job_id)
    references public.generation_jobs(user_id, id)
    on delete cascade,
  check (storage_path is not null or public_url is not null)
);

create table if not exists public.usage_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid,
  kind text not null,
  provider text not null,
  quantity numeric not null default 0 check (quantity >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint usage_records_job_owner_fkey
    foreign key (user_id, job_id)
    references public.generation_jobs(user_id, id)
    on delete set null (job_id)
);

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid,
  idempotency_key text,
  amount numeric not null default 0,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint credit_transactions_job_owner_fkey
    foreign key (user_id, job_id)
    references public.generation_jobs(user_id, id)
    on delete set null (job_id)
);

create table if not exists public.generation_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  requested_at timestamptz not null default now()
);

create index if not exists idx_projects_user_updated
  on public.projects(user_id, updated_at desc);
create index if not exists idx_jobs_user_created
  on public.generation_jobs(user_id, created_at desc);
create index if not exists idx_jobs_user_status
  on public.generation_jobs(user_id, status);
create index if not exists idx_jobs_project
  on public.generation_jobs(project_id)
  where project_id is not null;
create unique index if not exists idx_jobs_provider_job
  on public.generation_jobs(provider, provider_job_id)
  where provider_job_id is not null;
create index if not exists idx_generated_videos_user_created
  on public.generated_videos(user_id, created_at desc);
create index if not exists idx_usage_user_created
  on public.usage_records(user_id, created_at desc);
create index if not exists idx_credit_transactions_user_created
  on public.credit_transactions(user_id, created_at desc);
create unique index if not exists idx_credit_reservation_per_job
  on public.credit_transactions(user_id, job_id)
  where job_id is not null and reason = 'generation_reservation';
create unique index if not exists idx_credit_refund_per_job
  on public.credit_transactions(user_id, job_id)
  where job_id is not null and reason = 'generation_refund';
create unique index if not exists idx_credit_idempotency_key
  on public.credit_transactions(user_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_generation_rate_limits_user_requested
  on public.generation_rate_limits(user_id, requested_at desc);
create unique index if not exists idx_generation_rate_limits_request
  on public.generation_rate_limits(user_id, request_id);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.generated_videos enable row level security;
alter table public.usage_records enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.generation_rate_limits enable row level security;

revoke all on table
  public.profiles,
  public.projects,
  public.generation_jobs,
  public.generated_videos,
  public.usage_records,
  public.credit_transactions,
  public.generation_rate_limits
from public, anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select on
  public.generation_jobs,
  public.generated_videos,
  public.usage_records,
  public.credit_transactions
to authenticated;

grant select, insert, update on public.generation_jobs to service_role;
grant select, insert, update on public.generated_videos to service_role;
grant select, insert on public.usage_records to service_role;
grant select, insert on public.credit_transactions to service_role;
grant select, insert, delete on
  public.generation_rate_limits
to service_role;

drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "Users can access own projects" on public.projects;
create policy "Users can access own projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users can view own generation jobs" on public.generation_jobs;
create policy "Users can view own generation jobs" on public.generation_jobs
  for select using (auth.uid() = user_id);

drop policy if exists "Users can view own generated videos" on public.generated_videos;
create policy "Users can view own generated videos" on public.generated_videos
  for select using (auth.uid() = user_id);

drop policy if exists "Users can view own usage records" on public.usage_records;
create policy "Users can view own usage records" on public.usage_records
  for select using (auth.uid() = user_id);

drop policy if exists "Users can view own credit transactions" on public.credit_transactions;
create policy "Users can view own credit transactions" on public.credit_transactions
  for select using (auth.uid() = user_id);

create or replace function public.consume_generation_rate_limit(
  p_user_id uuid,
  p_request_id uuid,
  p_window_seconds integer default 60,
  p_max_requests integer default 3
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_count integer;
begin
  if p_user_id is null or p_request_id is null
    or p_window_seconds < 1 or p_window_seconds > 3600
    or p_max_requests < 1 or p_max_requests > 100 then
    raise exception 'Invalid rate limit parameters';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 73)
  );

  if exists (
    select 1
    from public.generation_rate_limits
    where user_id = p_user_id
      and request_id = p_request_id
  ) then
    return true;
  end if;

  delete from public.generation_rate_limits
  where user_id = p_user_id
    and requested_at < now() - make_interval(secs => p_window_seconds);

  select count(*) into request_count
  from public.generation_rate_limits
  where user_id = p_user_id
    and requested_at >= now() - make_interval(secs => p_window_seconds);

  if request_count >= p_max_requests then
    return false;
  end if;

  insert into public.generation_rate_limits (user_id, request_id)
  values (p_user_id, p_request_id);
  return true;
end;
$$;

create or replace function public.reserve_generation_credits(
  p_user_id uuid,
  p_job_id uuid,
  p_credit_cost numeric
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_balance numeric;
begin
  if p_user_id is null or p_job_id is null or p_credit_cost <= 0 then
    raise exception 'Invalid credit reservation parameters';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 91)
  );

  if exists (
    select 1
    from public.credit_transactions
    where user_id = p_user_id
      and job_id = p_job_id
      and reason = 'generation_reservation'
  ) then
    return true;
  end if;

  select coalesce(sum(amount), 0) into current_balance
  from public.credit_transactions
  where user_id = p_user_id;

  if current_balance < p_credit_cost then
    return false;
  end if;

  insert into public.credit_transactions (
    user_id,
    job_id,
    idempotency_key,
    amount,
    reason
  ) values (
    p_user_id,
    p_job_id,
    'generation-reservation:' || p_job_id::text,
    -p_credit_cost,
    'generation_reservation'
  );

  return true;
end;
$$;

create or replace function public.refund_generation_credits(
  p_user_id uuid,
  p_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reserved_amount numeric;
begin
  if p_user_id is null or p_job_id is null then
    raise exception 'Invalid credit refund parameters';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 91)
  );

  if exists (
    select 1
    from public.credit_transactions
    where user_id = p_user_id
      and job_id = p_job_id
      and reason = 'generation_refund'
  ) then
    return true;
  end if;

  select -amount into reserved_amount
  from public.credit_transactions
  where user_id = p_user_id
    and job_id = p_job_id
    and reason = 'generation_reservation';

  if reserved_amount is null then
    return false;
  end if;

  insert into public.credit_transactions (
    user_id,
    job_id,
    idempotency_key,
    amount,
    reason
  ) values (
    p_user_id,
    p_job_id,
    'generation-refund:' || p_job_id::text,
    reserved_amount,
    'generation_refund'
  );

  return true;
end;
$$;

create or replace function public.get_generation_credit_balance(p_user_id uuid)
returns table (balance numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(amount), 0)
  from public.credit_transactions
  where user_id = p_user_id
$$;

revoke all on function public.consume_generation_rate_limit(uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.reserve_generation_credits(uuid, uuid, numeric)
  from public, anon, authenticated;
revoke all on function public.refund_generation_credits(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.get_generation_credit_balance(uuid)
  from public, anon, authenticated;
grant execute on function public.consume_generation_rate_limit(uuid, uuid, integer, integer)
  to service_role;
grant execute on function public.reserve_generation_credits(uuid, uuid, numeric)
  to service_role;
grant execute on function public.refund_generation_credits(uuid, uuid)
  to service_role;
grant execute on function public.get_generation_credit_balance(uuid)
  to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_projects on public.projects;
create trigger set_updated_at_projects
  before update on public.projects
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at_jobs on public.generation_jobs;
create trigger set_updated_at_jobs
  before update on public.generation_jobs
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at_profiles on public.profiles;
create trigger set_updated_at_profiles
  before update on public.profiles
  for each row execute function public.set_updated_at();

revoke all on function public.set_updated_at() from public, anon, authenticated;
