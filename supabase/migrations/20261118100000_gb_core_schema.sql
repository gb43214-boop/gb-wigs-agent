-- GB Wigs: core schema
create table public.partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  telegram_chat_id bigint unique,
  telegram_link_code text unique default upper(substr(md5(gen_random_uuid()::text),1,8)),
  created_at timestamptz not null default now()
);
create table public.app_config (key text primary key, value text not null, updated_at timestamptz not null default now());
create table public.bot_messages (
  id bigserial primary key, chat_id bigint not null,
  role text not null check (role in ('user','model')), content text not null,
  created_at timestamptz not null default now()
);
create index on public.bot_messages (chat_id, id desc);
create table public.bot_memories (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references public.partners(id) on delete cascade,
  kind text not null default 'fact' check (kind in ('fact','preference','person','order','decision')),
  content text not null, created_at timestamptz not null default now()
);
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references public.partners(id) on delete cascade,
  message text not null, remind_at timestamptz not null, kind text not null default 'reminder',
  payload jsonb, sent_at timestamptz, created_at timestamptz not null default now()
);
create index on public.reminders (remind_at) where sent_at is null;
create table public.quiet_windows (start_at timestamptz primary key, end_at timestamptz not null, label text);
create table public.gmail_accounts (
  partner_id uuid primary key references public.partners(id) on delete cascade,
  email text, refresh_token text not null, scopes text, updated_at timestamptz not null default now()
);
create table public.gmail_oauth_states (
  state text primary key, partner_id uuid not null references public.partners(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null, phone text, email text, city text, event_type text, event_date date,
  hair_type text, hair_color text, head_measurements jsonb not null default '{}'::jsonb,
  wig_spec text, notes text, archived boolean not null default false, created_at timestamptz not null default now()
);
create index on public.customers (lower(full_name));
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null default 'custom_wig' check (kind in ('custom_wig','top_lace','stock_match','repair','other')),
  title text not null,
  status text not null default 'consultation' check (status in ('consultation','ordered','in_progress','ready','delivered','cancelled')),
  price numeric(10,2) not null default 0, due_date date, delivered_at date, spec text, notes text,
  created_at timestamptz not null default now()
);
create index on public.orders (customer_id);
create index on public.orders (status);
create table public.income (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  amount numeric(10,2) not null check (amount > 0), date date not null default current_date,
  kind text not null default 'payment' check (kind in ('deposit','balance','payment')),
  method text, invoice_number text, received_by uuid references public.partners(id), notes text,
  created_at timestamptz not null default now()
);
create index on public.income (order_id);
create index on public.income (date);
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  amount numeric(10,2) not null check (amount > 0), date date not null default current_date,
  vendor text, description text, category text, invoice_number text, receipt_path text,
  gmail_message_id text unique, paid_by uuid references public.partners(id), notes text,
  created_at timestamptz not null default now()
);
create index on public.expenses (order_id);
create index on public.expenses (date);
create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  from_partner uuid not null references public.partners(id), to_partner uuid not null references public.partners(id),
  amount numeric(10,2) not null check (amount > 0), date date not null default current_date, notes text,
  created_at timestamptz not null default now()
);
create table public.treatments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  kind text not null default 'other' check (kind in ('wash_style','cut_fit','repair','fitting','delivery','consultation','other')),
  date date not null default current_date, notes text, created_at timestamptz not null default now()
);
create index on public.treatments (customer_id, date desc);
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'regular' check (kind in ('consultation','regular','focus','away')),
  service text, title text not null,
  customer_id uuid references public.customers(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  starts_at timestamptz not null, ends_at timestamptz not null, all_day boolean not null default false, notes text,
  google_event_id text, google_etag text, google_dirty boolean not null default true,
  followup_sent boolean not null default false, reminded_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on public.appointments (starts_at);
create unique index on public.appointments (google_event_id) where google_event_id is not null;
create table public.calendar_outbox (id bigserial primary key, google_event_id text not null, created_at timestamptz not null default now());
create table public.tasks (
  id uuid primary key default gen_random_uuid(), title text not null, description text,
  order_id uuid references public.orders(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  due_date date, priority smallint not null default 2 check (priority between 1 and 3),
  status text not null default 'todo' check (status in ('todo','in_progress','done')),
  snooze_count int not null default 0, reminded_on date, created_at timestamptz not null default now()
);
create or replace function public.appointments_queue_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.google_event_id is not null then
    insert into public.calendar_outbox(google_event_id) values (old.google_event_id);
  end if;
  return old;
end $$;
create trigger appointments_queue_delete_t after delete on public.appointments
for each row execute function public.appointments_queue_delete();

create view public.order_financials with (security_invoker = true) as
select o.id as order_id, o.customer_id, o.title, o.kind, o.status, o.price, o.due_date, o.delivered_at,
  coalesce(i.paid,0) as paid, o.price - coalesce(i.paid,0) as balance_due,
  coalesce(e.spent,0) as expenses, coalesce(i.paid,0) - coalesce(e.spent,0) as profit_so_far,
  o.price - coalesce(e.spent,0) as expected_profit
from public.orders o
left join (select order_id, sum(amount) paid from public.income group by order_id) i on i.order_id = o.id
left join (select order_id, sum(amount) spent from public.expenses group by order_id) e on e.order_id = o.id
where o.status <> 'cancelled';
create view public.customer_financials with (security_invoker = true) as
select c.id as customer_id, c.full_name, c.phone,
  coalesce(sum(f.price),0) as total_price, coalesce(sum(f.paid),0) as total_paid,
  coalesce(sum(f.balance_due),0) as total_due, coalesce(sum(f.profit_so_far),0) as profit_so_far
from public.customers c left join public.order_financials f on f.customer_id = c.id
group by c.id, c.full_name, c.phone;

insert into public.app_config(key, value) values
  ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('multi_partner', 'false'),
  ('timezone', 'Asia/Jerusalem'),
  ('work_hours', '{"0":[["10:00","16:00"]],"1":[["19:00","22:00"]],"2":[["19:00","22:00"]],"3":[["19:00","22:00"]],"4":[["10:00","16:00"]]}'),
  ('durations', '{"regular":30,"consultation":60}'),
  ('quiet_before_min', '30'), ('quiet_after_min', '10'),
  ('hebcal_geo', '{"latitude":32.0834,"longitude":34.8333,"tzid":"Asia/Jerusalem","name":"Bnei Brak"}');
insert into public.partners(name) values ('גיטי');
insert into storage.buckets (id, name, public) values ('receipts','receipts', false) on conflict (id) do nothing;

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
