-- Costs of a site entered by hand (costi): materials, rentals, subcontracts and others,
-- optionally with the supplier. Labour and vehicle costs come from daily reports instead.

create table public.site_costs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  site_id uuid not null,
  cost_date date not null,
  category text not null
    check (category in ('materials', 'rentals', 'subcontract', 'other')),
  description text not null check (char_length(description) between 1 and 300),
  supplier_id uuid,
  amount_cents bigint not null check (amount_cents >= 0),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete restrict,
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
    on delete restrict
);
create index site_costs_company_date_idx on public.site_costs (company_id, cost_date, id);
create index site_costs_site_idx on public.site_costs (site_id);
create index site_costs_supplier_idx on public.site_costs (supplier_id)
  where supplier_id is not null;

alter table public.site_costs enable row level security;

create policy site_costs_select on public.site_costs
  for select using (company_id = app.current_company_id());
create policy site_costs_insert on public.site_costs
  for insert with check (company_id = app.current_company_id());
create policy site_costs_update on public.site_costs
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy site_costs_delete on public.site_costs
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.site_costs to gestionale_app;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost'
  ));

create trigger site_costs_audit after insert or update or delete on public.site_costs
  for each row execute function app.audit_row('site_cost');
