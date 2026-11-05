-- Contrail call recordings. Run once in Supabase: SQL Editor -> paste -> Run. Safe to run again.
-- Staff upload a recording to a call request; it's stored privately and only signed-in staff can play it.

alter table public.call_requests add column if not exists recording_path text
  check (recording_path is null or char_length(recording_path) <= 300);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 52428800,
        array['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/opus'])
on conflict (id) do nothing;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'staff play recordings') then
    create policy "staff play recordings" on storage.objects for select to authenticated using (bucket_id = 'recordings' and public.is_staff());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'staff add recordings') then
    create policy "staff add recordings" on storage.objects for insert to authenticated with check (bucket_id = 'recordings' and public.is_staff());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'staff remove recordings') then
    create policy "staff remove recordings" on storage.objects for delete to authenticated using (bucket_id = 'recordings' and public.is_staff());
  end if;
end $$;
