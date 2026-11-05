-- Contrail quote picks and quote alerts (adds to quotes.sql; quotes.sql already includes all of this).
-- Run once in Supabase: SQL Editor -> paste -> Run. Safe to run again.
alter table public.quotes add column if not exists chosen_option int check (chosen_option is null or chosen_option between 0 and 7);
alter table public.quotes add column if not exists chosen_at timestamptz;

-- The customer's quote page calls this with the token from its link. It returns only that quote's public fields
-- and counts the view. Nothing else in the database is reachable this way.
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
    'quote_no', q.id, 'customer_name', q.customer_name, 'origin', q.origin, 'destination', q.destination,
    'from_city', q.from_city, 'to_city', q.to_city, 'travel_date', q.travel_date, 'date_label', q.date_label,
    'travelers', q.travelers, 'options', q.options, 'note', q.note, 'book_url', q.book_url,
    'prepared_name', q.prepared_name, 'created_at', q.created_at, 'expires_at', q.expires_at,
    'chosen_option', q.chosen_option, 'expired', q.expires_at < now());
end $$;
-- The customer taps "I want this one" on their quote. Records the pick, puts the request back at the top of the
-- staff list (due now, with a note), and the trigger below alerts staff phones.
create or replace function public.choose_quote_option(t text, opt int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q public.quotes; o jsonb; line text;
begin
  if t is null or char_length(t) < 20 or char_length(t) > 64 or opt is null then return jsonb_build_object('ok', false); end if;
  select * into q from public.quotes where token = t;
  if q.id is null or opt < 0 or opt >= jsonb_array_length(q.options) then return jsonb_build_object('ok', false); end if;
  if q.expires_at < now() then return jsonb_build_object('ok', false, 'expired', true); end if;
  if q.chosen_option = opt then return jsonb_build_object('ok', true, 'chosen_option', opt); end if;   -- tapped twice
  if q.chosen_at > now() - interval '20 seconds' then return jsonb_build_object('ok', false, 'slow_down', true); end if;
  update public.quotes set chosen_option = opt, chosen_at = now() where id = q.id;
  o := q.options -> opt;
  line := to_char(now() at time zone 'America/New_York', 'Mon FMDD, FMHH12:MI AM') || ' · Customer picked Option ' || (opt + 1) ||
          ' on their quote: ' || coalesce(o ->> 'airline', '') || ' ' || coalesce(o ->> 'flights', '') || ', ' ||
          coalesce(o ->> 'dep', '') || ' → ' || coalesce(o ->> 'arr', '') || '. Call them to book.';
  if q.call_id is not null then
    update public.call_requests set
      notes = left(coalesce(nullif(notes, '') || E'\n', '') || line, 20000),
      status = case when status = 'Booked' then status else 'Scheduled' end,
      call_at = case when status = 'Booked' then call_at else now() end,
      updated_at = now()
    where id = q.call_id;
  end if;
  return jsonb_build_object('ok', true, 'chosen_option', opt);
end $$;
grant execute on function public.choose_quote_option(text, int) to anon, authenticated;

-- Phone alerts to staff: the first time a customer opens a quote, and whenever they pick an option.
create or replace function public.notify_quote_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; title text; body text; o jsonb; first text := split_part(trim(new.customer_name), ' ', 1);
begin
  if old.views = 0 and new.views > 0 then
    title := first || ' opened their quote';
    body := coalesce(new.origin, '') || ' → ' || coalesce(new.destination, '') || coalesce(' · ' || new.date_label, '') || '. Good time to call.';
  elsif new.chosen_option is not null and new.chosen_option is distinct from old.chosen_option then
    o := new.options -> new.chosen_option;
    title := first || ' picked Option ' || (new.chosen_option + 1);
    body := coalesce(o ->> 'airline', '') || ' ' || coalesce(o ->> 'dep', '') || ' → ' || coalesce(o ->> 'arr', '') ||
            coalesce(' · ' || new.date_label, '') || '. Call them to book.';
  else
    return new;
  end if;
  select key into k from public.webhook_keys where name = 'ai-receptionist';
  if k is not null then
    perform net.http_post(
      url := 'https://lmtmbovxsagchlwczmpd.supabase.co/functions/v1/push-notify',
      body := jsonb_build_object('alert', jsonb_build_object('title', title, 'body', body,
        'url', 'https://dylgas.github.io/Contrail/staff/' || coalesce('#call=' || new.call_id, '#calls'), 'tag', 'quote-' || new.id)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k));
  end if;
  return new;
exception when others then
  return new;   -- never block a quote update because an alert failed
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'quotes_push') then
    create trigger quotes_push after update of views, chosen_option on public.quotes for each row execute function public.notify_quote_activity();
  end if;
end $$;
