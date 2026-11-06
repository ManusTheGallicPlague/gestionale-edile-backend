-- Documents and photos of a site (archivio file). The metadata lives in site_documents, the
-- bytes in site_document_files, so lists and the audit log never touch the file itself.
-- At most 20 MB per file (checked by the API, and here as a last line of defence).

create table public.site_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  site_id uuid not null,
  kind text not null check (kind in ('document', 'photo')),
  title text not null check (char_length(title) between 1 and 200),
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  size_bytes integer not null check (size_bytes between 1 and 20971520),
  notes text check (char_length(notes) <= 2000),
  uploaded_by uuid references auth.users (id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, site_id) references public.sites (company_id, id) on delete restrict
);
create index site_documents_site_idx on public.site_documents (site_id, created_at desc, id);
create index site_documents_company_idx on public.site_documents (company_id);

create table public.site_document_files (
  document_id uuid primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  data bytea not null check (octet_length(data) between 1 and 20971520),
  foreign key (company_id, document_id) references public.site_documents (company_id, id)
    on delete cascade
);
create index site_document_files_company_idx on public.site_document_files (company_id);

alter table public.site_documents enable row level security;
alter table public.site_document_files enable row level security;

create policy site_documents_select on public.site_documents
  for select using (company_id = app.current_company_id());
create policy site_documents_insert on public.site_documents
  for insert with check (company_id = app.current_company_id());
create policy site_documents_update on public.site_documents
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy site_documents_delete on public.site_documents
  for delete using (company_id = app.current_company_id());

-- The bytes never change: they are written once and go away with the document.
create policy site_document_files_select on public.site_document_files
  for select using (company_id = app.current_company_id());
create policy site_document_files_insert on public.site_document_files
  for insert with check (company_id = app.current_company_id());

grant select, insert, update, delete on public.site_documents to gestionale_app;
grant select, insert on public.site_document_files to gestionale_app;

alter table public.audit_log drop constraint audit_log_entity_check;
alter table public.audit_log add constraint audit_log_entity_check
  check (entity in (
    'client', 'supplier', 'deadline', 'estimate', 'quote', 'site', 'employee', 'vehicle',
    'daily_report', 'site_cost', 'site_document'
  ));

create trigger site_documents_audit after insert or update or delete on public.site_documents
  for each row execute function app.audit_row('site_document');
