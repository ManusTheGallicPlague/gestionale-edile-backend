-- Compliance documents of suppliers (above all subcontractors): DURC, chamber of commerce
-- extract, insurance. Each one may expire; the deadline calendar will read them from here.

-- Lets documents check that the supplier belongs to the same company.
alter table public.suppliers add constraint suppliers_company_id_id_key unique (company_id, id);

create table public.supplier_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  supplier_id uuid not null,
  kind text not null check (kind in ('durc', 'chamber_extract', 'insurance', 'other')),
  description text check (char_length(description) between 1 and 200),
  issued_on date,
  expires_on date,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (issued_on is null or expires_on is null or expires_on >= issued_on),
  -- A supplier with documents cannot be deleted: it is archived instead.
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
    on delete restrict
);
create index supplier_documents_supplier_idx on public.supplier_documents (supplier_id);
create index supplier_documents_company_expiry_idx
  on public.supplier_documents (company_id, expires_on);

alter table public.supplier_documents enable row level security;

create policy supplier_documents_select on public.supplier_documents
  for select using (company_id = app.current_company_id());
create policy supplier_documents_insert on public.supplier_documents
  for insert with check (company_id = app.current_company_id());
create policy supplier_documents_update on public.supplier_documents
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy supplier_documents_delete on public.supplier_documents
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.supplier_documents to gestionale_app;
