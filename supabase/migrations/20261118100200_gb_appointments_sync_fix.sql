alter table public.appointments add column if not exists daybefore_sent boolean not null default false;
create or replace function public.appointments_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE'
     and new.google_etag is not distinct from old.google_etag
     and (new.title, new.starts_at, new.ends_at, new.all_day, new.notes)
         is distinct from (old.title, old.starts_at, old.ends_at, old.all_day, old.notes) then
    new.google_dirty := true;
  end if;
  return new;
end $$;
