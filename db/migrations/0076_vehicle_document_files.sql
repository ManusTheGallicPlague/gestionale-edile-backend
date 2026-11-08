-- The file of a vehicle document (the scan of the insurance policy or of the registration
-- certificate): at most one per document, replaced by uploading another, as for the supplier
-- documents (0048). The bytes live apart from the metadata, so the list never reads them.

create table public.vehicle_document_files (
  document_id uuid primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes between 1 and 20971520),
  data bytea not null check (octet_length(data) between 1 and 20971520),
  created_at timestamptz not null default now(),
  check (octet_length(data) = size_bytes),
  foreign key (company_id, document_id) references public.vehicle_documents (company_id, id)
    on delete cascade
);
create index vehicle_document_files_company_idx on public.vehicle_document_files (company_id);

alter table public.vehicle_document_files enable row level security;

create policy vehicle_document_files_select on public.vehicle_document_files
  for select using (company_id = app.current_company_id());
create policy vehicle_document_files_insert on public.vehicle_document_files
  for insert with check (company_id = app.current_company_id());
create policy vehicle_document_files_delete on public.vehicle_document_files
  for delete using (company_id = app.current_company_id());

-- A file is never changed in place: replacing it deletes the old one and writes the new one.
grant select, insert, delete on public.vehicle_document_files to gestionale_app;
