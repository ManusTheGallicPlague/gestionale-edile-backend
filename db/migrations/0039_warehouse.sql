-- Warehouse (magazzino): items with a unit, and movements in (carico) and out (scarico),
-- optionally towards a site. The stock is the sum of the movements. Movements never change:
-- they are deleted and entered again. An item with movements cannot be deleted.

create table public.warehouse_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text check (char_length(code) between 1 and 50),
  name text not null check (char_length(name) between 1 and 200),
  unit text not null check (char_length(unit) between 1 and 20),
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index warehouse_items_code_idx on public.warehouse_items (company_id, lower(code))
  where code is not null;
create index warehouse_items_company_name_idx on public.warehouse_items (company_id, name);

create table public.warehouse_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  item_id uuid not null,
  movement_date date not null,
  kind text not null check (kind in ('in', 'out')),
  quantity numeric(14, 3) not null check (quantity > 0),
  site_id uuid,
  notes text check (char_length(notes) <= 2000),
  -- Who entered it: no foreign key, users live in the auth schema.
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, item_id) references public.warehouse_items (company_id, id)
    on delete restrict,
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete restrict
);
create index warehouse_movements_company_date_idx
  on public.warehouse_movements (company_id, movement_date, id);
create index warehouse_movements_item_idx on public.warehouse_movements (item_id);
create index warehouse_movements_site_idx on public.warehouse_movements (site_id)
  where site_id is not null;

alter table public.warehouse_items enable row level security;
alter table public.warehouse_movements enable row level security;

create policy warehouse_items_select on public.warehouse_items
  for select using (company_id = app.current_company_id());
create policy warehouse_items_insert on public.warehouse_items
  for insert with check (company_id = app.current_company_id());
create policy warehouse_items_update on public.warehouse_items
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy warehouse_items_delete on public.warehouse_items
  for delete using (company_id = app.current_company_id());

create policy warehouse_movements_select on public.warehouse_movements
  for select using (company_id = app.current_company_id());
create policy warehouse_movements_insert on public.warehouse_movements
  for insert with check (company_id = app.current_company_id());
create policy warehouse_movements_delete on public.warehouse_movements
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.warehouse_items to gestionale_app;
-- Movements are never changed.
grant select, insert, delete on public.warehouse_movements to gestionale_app;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item'
  ));

create trigger warehouse_items_audit after insert or update or delete on public.warehouse_items
  for each row execute function app.audit_row('warehouse_item');
