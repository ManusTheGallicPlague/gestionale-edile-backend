-- Purchase orders (ordini ai fornitori): supplier, optional site, date and lines with
-- description, unit, quantity and price. Draft → sent → received; only drafts change.
-- The number (2026/001) is given at creation, per company and year of the order date.
-- Suppliers and sites named in an order cannot be deleted.

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number_year integer not null check (number_year between 2000 and 2999),
  number_seq integer not null check (number_seq > 0),
  supplier_id uuid not null,
  site_id uuid,
  order_date date not null,
  delivery_date date,
  status text not null default 'draft' check (status in ('draft', 'sent', 'received')),
  notes text check (char_length(notes) <= 2000),
  sent_at timestamptz,
  received_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, number_year, number_seq),
  check (delivery_date is null or delivery_date >= order_date),
  check ((status = 'draft') = (sent_at is null)),
  check ((status = 'received') = (received_at is not null)),
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
    on delete restrict,
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete restrict
);
create index purchase_orders_company_date_idx
  on public.purchase_orders (company_id, order_date, id);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id);
create index purchase_orders_site_idx on public.purchase_orders (site_id)
  where site_id is not null;

create table public.purchase_order_lines (
  company_id uuid not null references public.companies (id) on delete cascade,
  order_id uuid not null,
  position integer not null check (position >= 0),
  description text not null check (char_length(description) between 1 and 500),
  unit text check (char_length(unit) <= 20),
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  primary key (order_id, position),
  foreign key (company_id, order_id) references public.purchase_orders (company_id, id)
    on delete cascade
);

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;

create policy purchase_orders_select on public.purchase_orders
  for select using (company_id = app.current_company_id());
create policy purchase_orders_insert on public.purchase_orders
  for insert with check (company_id = app.current_company_id());
create policy purchase_orders_update on public.purchase_orders
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy purchase_orders_delete on public.purchase_orders
  for delete using (company_id = app.current_company_id());

create policy purchase_order_lines_select on public.purchase_order_lines
  for select using (company_id = app.current_company_id());
create policy purchase_order_lines_insert on public.purchase_order_lines
  for insert with check (company_id = app.current_company_id());
create policy purchase_order_lines_delete on public.purchase_order_lines
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.purchase_orders to gestionale_app;
-- The lines are replaced as a whole on every save: no update.
grant select, insert, delete on public.purchase_order_lines to gestionale_app;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order'
  ));

create trigger purchase_orders_audit after insert or update or delete on public.purchase_orders
  for each row execute function app.audit_row('purchase_order');
