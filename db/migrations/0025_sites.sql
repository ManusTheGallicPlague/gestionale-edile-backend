-- Construction sites (cantieri): the header. Daily reports, costs, team and documents
-- will point here. A client with sites cannot be deleted.

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text check (char_length(code) between 1 and 50),
  name text not null check (char_length(name) between 1 and 200),
  client_id uuid,
  address text check (char_length(address) <= 300),
  status text not null default 'planned'
    check (status in ('planned', 'active', 'suspended', 'completed')),
  start_on date,
  end_on date,
  budget_cents bigint check (budget_cents >= 0),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (end_on is null or start_on is null or end_on >= start_on),
  foreign key (company_id, client_id) references public.clients (company_id, id)
    on delete restrict
);
create unique index sites_company_code_idx on public.sites (company_id, lower(code))
  where code is not null;
create index sites_company_updated_idx on public.sites (company_id, updated_at, id);
create index sites_client_idx on public.sites (client_id) where client_id is not null;

alter table public.sites enable row level security;

create policy sites_select on public.sites
  for select using (company_id = app.current_company_id());
create policy sites_insert on public.sites
  for insert with check (company_id = app.current_company_id());
create policy sites_update on public.sites
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy sites_delete on public.sites
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.sites to gestionale_app;

-- The audit log records sites too.
alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in ('client', 'supplier', 'deadline', 'estimate', 'quote', 'site'));

create trigger sites_audit after insert or update or delete on public.sites
  for each row execute function app.audit_row('site');
