-- Invoices register (registro delle fatture): issued to clients and received from suppliers.
-- Only a register, nothing is sent to the SDI. Amounts in integer cents; the total is
-- taxable + VAT. The payment due date becomes a deadline of the calendar, kept in step by
-- the API (done when the invoice is paid) and deleted with the invoice.
-- Clients, suppliers and sites named in an invoice cannot be deleted.

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  direction text not null check (direction in ('issued', 'received')),
  number text not null check (char_length(number) between 1 and 40),
  invoice_date date not null,
  number_year integer generated always as (extract(year from invoice_date)::integer) stored,
  client_id uuid,
  supplier_id uuid,
  site_id uuid,
  description text check (char_length(description) <= 500),
  taxable_cents bigint not null check (taxable_cents >= 0),
  vat_cents bigint not null check (vat_cents >= 0),
  due_date date,
  paid_on date,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (taxable_cents + vat_cents <= 100000000000000),
  check ((direction = 'issued') = (client_id is not null)),
  check ((direction = 'received') = (supplier_id is not null)),
  check (due_date is null or due_date >= invoice_date),
  foreign key (company_id, client_id) references public.clients (company_id, id)
    on delete restrict,
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
    on delete restrict,
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete restrict
);
-- Our own numbering is one per year; a supplier's is one per supplier and year.
create unique index invoices_issued_number_key
  on public.invoices (company_id, number_year, lower(number)) where direction = 'issued';
create unique index invoices_received_number_key
  on public.invoices (company_id, supplier_id, number_year, lower(number))
  where direction = 'received';
create index invoices_company_date_idx on public.invoices (company_id, invoice_date, id);
create index invoices_client_idx on public.invoices (client_id) where client_id is not null;
create index invoices_supplier_idx on public.invoices (supplier_id) where supplier_id is not null;
create index invoices_site_idx on public.invoices (site_id) where site_id is not null;

alter table public.invoices enable row level security;

create policy invoices_select on public.invoices
  for select using (company_id = app.current_company_id());
create policy invoices_insert on public.invoices
  for insert with check (company_id = app.current_company_id());
create policy invoices_update on public.invoices
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy invoices_delete on public.invoices
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.invoices to gestionale_app;

alter table public.deadlines
  add column invoice_id uuid,
  add constraint deadlines_invoice_key unique (invoice_id),
  add constraint deadlines_invoice_fkey foreign key (company_id, invoice_id)
    references public.invoices (company_id, id) on delete cascade;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document', 'purchase_order', 'warehouse_item', 'invoice'
  ));

create trigger invoices_audit after insert or update or delete on public.invoices
  for each row execute function app.audit_row('invoice');
