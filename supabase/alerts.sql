-- Contrail staff phone alerts. Run once in Supabase: SQL Editor -> paste -> Run. Safe to run again.

-- One row per staff device that turned on alerts.
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own devices read" on public.push_subscriptions;
create policy "own devices read" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists "own devices add" on public.push_subscriptions;
create policy "own devices add" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid() and public.is_staff());
drop policy if exists "own devices update" on public.push_subscriptions;
create policy "own devices update" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own devices remove" on public.push_subscriptions;
create policy "own devices remove" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Server-only settings (the alert signing keys are created here automatically; nobody can read them from the website).
create table if not exists public.app_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- When a call request is added, ask the alert service to notify staff.
create extension if not exists pg_net with schema extensions;
create or replace function public.notify_new_call() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  select key into k from public.webhook_keys where name = 'ai-receptionist';
  if k is not null then
    perform net.http_post(
      url := 'https://lmtmbovxsagchlwczmpd.supabase.co/functions/v1/push-notify',
      body := jsonb_build_object('record', to_jsonb(new) - 'raw'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k)
    );
  end if;
  return new;
exception when others then
  return new;   -- never block saving a call request because an alert failed
end $$;
drop trigger if exists call_requests_push on public.call_requests;
create trigger call_requests_push after insert on public.call_requests for each row execute function public.notify_new_call();
