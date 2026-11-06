-- Quotes (preventivi): the header. The number (2026/001) is given when the quote is first
-- sent, from a per-company, per-year counter locked during the transaction, so numbers
-- have no gaps. Drafts have no number and no date. Lines come next.

create table public.quote_counters (
  company_id uuid not null references public.companies (id) on delete cascade,
  year integer not null check (year between 2000 and 9999),
  last_number integer not null check (last_number >= 0),
  primary key (company_id, year)
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null,
  subject text not null check (char_length(subject) between 1 and 200),
  validity_days integer not null default 30 check (validity_days between 1 and 365),
  notes text check (char_length(notes) <= 5000),
  terms text check (char_length(terms) <= 10000),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  number_year integer,
  number_seq integer check (number_seq > 0),
  issue_date date,
  sent_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number_year, number_seq),
  check ((status = 'draft') = (number_seq is null)),
  check ((number_seq is null) = (number_year is null)),
  check ((number_seq is null) = (issue_date is null)),
  foreign key (company_id, client_id) references public.clients (company_id, id)
    on delete restrict
);
create index quotes_company_updated_idx on public.quotes (company_id, updated_at, id);
create index quotes_client_idx on public.quotes (client_id);

alter table public.quote_counters enable row level security;
alter table public.quotes enable row level security;

create policy quote_counters_select on public.quote_counters
  for select using (company_id = app.current_company_id());
create policy quote_counters_insert on public.quote_counters
  for insert with check (company_id = app.current_company_id());
create policy quote_counters_update on public.quote_counters
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());

create policy quotes_select on public.quotes
  for select using (company_id = app.current_company_id());
create policy quotes_insert on public.quotes
  for insert with check (company_id = app.current_company_id());
create policy quotes_update on public.quotes
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy quotes_delete on public.quotes
  for delete using (company_id = app.current_company_id());

grant select, insert, update on public.quote_counters to gestionale_app;
grant select, insert, update, delete on public.quotes to gestionale_app;
