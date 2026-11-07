-- Partial payments of an invoice (instalments, advances): collected on issued invoices,
-- paid on received ones. A payment is never changed in place: a wrong one is deleted and
-- registered again. Their sum never goes beyond the amount due: the API checks it while the
-- invoice row is locked by the version bump.

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  invoice_id uuid not null,
  payment_date date not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents < 100000000000000),
  method text check (method in ('bank_transfer', 'riba', 'check', 'cash', 'card', 'other')),
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  foreign key (company_id, invoice_id) references public.invoices (company_id, id)
    on delete cascade
);
create index invoice_payments_invoice_idx on public.invoice_payments (invoice_id, payment_date);
create index invoice_payments_company_idx on public.invoice_payments (company_id);

alter table public.invoice_payments enable row level security;

create policy invoice_payments_select on public.invoice_payments
  for select using (company_id = app.current_company_id());
create policy invoice_payments_insert on public.invoice_payments
  for insert with check (company_id = app.current_company_id());
create policy invoice_payments_delete on public.invoice_payments
  for delete using (company_id = app.current_company_id());

grant select, insert, delete on public.invoice_payments to gestionale_app;
