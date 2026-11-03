-- Contrail staff database. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again: it only creates what is missing and replaces the rules.

-- ---------- Staff profiles (one per login) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

-- Every new login gets a staff profile automatically.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- Call requests (website form, phone, AI receptionist) ----------
create table if not exists public.call_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 120),
  phone text not null check (char_length(phone) between 7 and 30),
  email text check (email is null or char_length(email) <= 200),
  trip text check (trip is null or char_length(trip) <= 300),
  best_time text check (best_time is null or char_length(best_time) <= 120),
  message text check (message is null or char_length(message) <= 2000),
  source text not null default 'Website form' check (source in ('Website form', 'Phone', 'AI receptionist')),
  status text not null default 'New' check (status in ('New', 'Scheduled', 'Called', 'Booked', 'No answer', 'Closed')),
  call_at timestamptz,
  assigned_to uuid references public.profiles (id) on delete set null,
  notes text,
  updated_at timestamptz not null default now()
);
create index if not exists call_requests_created on public.call_requests (created_at desc);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists call_requests_touch on public.call_requests;
create trigger call_requests_touch before update on public.call_requests for each row execute function public.touch_updated_at();

-- ---------- Bookings (filled by the daily Travelpayouts sync) ----------
create table if not exists public.bookings (
  id text primary key,
  booked_on date,
  route text,
  travel_date date,
  partner text,
  fare_usd numeric(10, 2),
  commission_usd numeric(10, 2),
  status text,
  synced_at timestamptz not null default now()
);

-- ---------- Calendar events staff add themselves ----------
create table if not exists public.events (
  id bigint generated always as identity primary key,
  starts_at timestamptz not null,
  title text not null check (char_length(title) between 1 and 160),
  detail text,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- Security rules ----------
alter table public.profiles enable row level security;
alter table public.call_requests enable row level security;
alter table public.bookings enable row level security;
alter table public.events enable row level security;

drop policy if exists "staff read profiles" on public.profiles;
create policy "staff read profiles" on public.profiles for select to authenticated using (public.is_staff());
drop policy if exists "edit own name" on public.profiles;
create policy "edit own name" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "admin manages profiles" on public.profiles;
-- Staff can change only their own display name. Roles are changed by the owner in the SQL editor.

-- The public website may only add a brand-new request. It can never read, change or delete one.
drop policy if exists "website adds requests" on public.call_requests;
create policy "website adds requests" on public.call_requests for insert to anon
  with check (source = 'Website form' and status = 'New' and call_at is null and assigned_to is null and notes is null);
drop policy if exists "staff read requests" on public.call_requests;
create policy "staff read requests" on public.call_requests for select to authenticated using (public.is_staff());
drop policy if exists "staff add requests" on public.call_requests;
create policy "staff add requests" on public.call_requests for insert to authenticated with check (public.is_staff());
drop policy if exists "staff update requests" on public.call_requests;
create policy "staff update requests" on public.call_requests for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "admin deletes requests" on public.call_requests;
create policy "admin deletes requests" on public.call_requests for delete to authenticated using (public.is_admin());

drop policy if exists "staff read bookings" on public.bookings;
create policy "staff read bookings" on public.bookings for select to authenticated using (public.is_staff());
-- Bookings are written only by the sync job, which uses the secret service key.

drop policy if exists "staff read events" on public.events;
create policy "staff read events" on public.events for select to authenticated using (public.is_staff());
drop policy if exists "staff add events" on public.events;
create policy "staff add events" on public.events for insert to authenticated with check (public.is_staff());
drop policy if exists "staff edit events" on public.events;
create policy "staff edit events" on public.events for update to authenticated using (public.is_staff());
drop policy if exists "staff delete events" on public.events;
create policy "staff delete events" on public.events for delete to authenticated using (public.is_staff());

grant insert on public.call_requests to anon;
grant select, insert, update, delete on public.call_requests, public.events to authenticated;
grant select on public.bookings, public.profiles to authenticated;
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

-- Live updates for the staff site
do $$ begin
  begin alter publication supabase_realtime add table public.call_requests; exception when others then null; end;
  begin alter publication supabase_realtime add table public.events; exception when others then null; end;
end $$;

-- After creating your own login, make yourself the admin (put your email in):
-- update public.profiles set role = 'admin' where email = 'you@example.com';
