-- The PDF of a registered invoice (the courtesy copy of an e-invoice, or a scan of a paper
-- one): at most one per invoice, replaced by uploading another. Same shape as the files of
-- supplier documents.

create table public.invoice_files (
  invoice_id uuid primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes between 1 and 20971520),
  data bytea not null check (octet_length(data) between 1 and 20971520),
  created_at timestamptz not null default now(),
  check (octet_length(data) = size_bytes),
  foreign key (company_id, invoice_id) references public.invoices (company_id, id)
    on delete cascade
);
create index invoice_files_company_idx on public.invoice_files (company_id);

alter table public.invoice_files enable row level security;

create policy invoice_files_select on public.invoice_files
  for select using (company_id = app.current_company_id());
create policy invoice_files_insert on public.invoice_files
  for insert with check (company_id = app.current_company_id());
create policy invoice_files_delete on public.invoice_files
  for delete using (company_id = app.current_company_id());

-- A file is never changed in place: replacing it deletes the old one and writes the new one.
grant select, insert, delete on public.invoice_files to gestionale_app;
