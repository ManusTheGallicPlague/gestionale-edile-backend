-- Deadlines: the company's calendar of things due (DURC, insurance, taxes, invoices...).
-- Amounts in integer cents. A deadline may point to one client or one supplier of the
-- same company; those cannot be deleted while a deadline points to them.

alter table public.clients add constraint clients_company_id_id_key unique (company_id, id);

create table public.deadlines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  due_on date not null,
  kind text not null
    check (kind in ('durc', 'insurance', 'tax', 'invoice_in', 'invoice_out', 'contract',
                    'vehicle', 'other')),
  amount_cents bigint check (amount_cents >= 0),
  client_id uuid,
  supplier_id uuid,
  notes text check (char_length(notes) <= 2000),
  status text not null default 'open' check (status in ('open', 'done')),
  done_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (client_id is null or supplier_id is null),
  check ((status = 'done') = (done_at is not null)),
  foreign key (company_id, client_id) references public.clients (company_id, id)
    on delete restrict,
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
    on delete restrict
);
create index deadlines_company_due_idx on public.deadlines (company_id, due_on, id);
create index deadlines_client_idx on public.deadlines (client_id) where client_id is not null;
create index deadlines_supplier_idx on public.deadlines (supplier_id)
  where supplier_id is not null;

alter table public.deadlines enable row level security;

create policy deadlines_select on public.deadlines
  for select using (company_id = app.current_company_id());
create policy deadlines_insert on public.deadlines
  for insert with check (company_id = app.current_company_id());
create policy deadlines_update on public.deadlines
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy deadlines_delete on public.deadlines
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.deadlines to gestionale_app;
