-- Contrail quote sheets. Run once in Supabase: SQL Editor -> paste -> Run. Safe to run again.
-- Staff create quotes in the dashboard. Customers open them with an unguessable link; they can never list or change quotes.

create table if not exists public.quotes (
  id bigint generated always as identity primary key,
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  call_id bigint references public.call_requests (id) on delete set null,
  customer_name text not null check (char_length(customer_name) between 1 and 120),
  origin text check (origin is null or char_length(origin) <= 10),
  destination text check (destination is null or char_length(destination) <= 10),
  from_city text check (from_city is null or char_length(from_city) <= 80),
  to_city text check (to_city is null or char_length(to_city) <= 80),
  travel_date date,
  date_label text check (date_label is null or char_length(date_label) <= 80),
  travelers int check (travelers is null or travelers between 1 and 99),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 1 and 8),
  note text check (note is null or char_length(note) <= 1500),
  book_url text check (book_url is null or (char_length(book_url) <= 300 and book_url like 'https://dylgas.github.io/Contrail/%')),
  prepared_by uuid default auth.uid() references public.profiles (id) on delete set null,
  prepared_name text check (prepared_name is null or char_length(prepared_name) <= 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  views int not null default 0,
  viewed_at timestamptz
);
create index if not exists quotes_call on public.quotes (call_id);

alter table public.quotes enable row level security;
drop policy if exists "staff read quotes" on public.quotes;
create policy "staff read quotes" on public.quotes for select to authenticated using (public.is_staff());
drop policy if exists "staff add quotes" on public.quotes;
create policy "staff add quotes" on public.quotes for insert to authenticated with check (public.is_staff() and views = 0 and viewed_at is null);
drop policy if exists "staff edit quotes" on public.quotes;
create policy "staff edit quotes" on public.quotes for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "admin deletes quotes" on public.quotes;
create policy "admin deletes quotes" on public.quotes for delete to authenticated using (public.is_admin());
revoke all on public.quotes from anon;
grant select, insert, update, delete on public.quotes to authenticated;

-- The customer's quote page calls this with the token from its link. It returns only that quote's public fields
-- and counts the view. Nothing else in the database is reachable this way.
drop function if exists public.get_quote(text);
create or replace function public.get_quote(t text, count_view boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if t is null or char_length(t) < 20 or char_length(t) > 64 then return null; end if;
  if count_view then
    update public.quotes set views = views + 1, viewed_at = now() where token = t returning * into q;
  else
    select * into q from public.quotes where token = t;
  end if;
  if q.id is null then return null; end if;
  return jsonb_build_object(
    'customer_name', q.customer_name, 'origin', q.origin, 'destination', q.destination,
    'from_city', q.from_city, 'to_city', q.to_city, 'travel_date', q.travel_date, 'date_label', q.date_label,
    'travelers', q.travelers, 'options', q.options, 'note', q.note, 'book_url', q.book_url,
    'prepared_name', q.prepared_name, 'created_at', q.created_at, 'expires_at', q.expires_at,
    'expired', q.expires_at < now());
end $$;
revoke all on function public.get_quote(text, boolean) from public;
grant execute on function public.get_quote(text, boolean) to anon, authenticated;
