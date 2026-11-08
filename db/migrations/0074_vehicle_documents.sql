-- Documents of vehicles that expire: motor insurance (RCA), road tax (bollo), registration
-- certificate, tachograph calibration. A document with an expiry becomes a real deadline of the
-- vehicle, kept in step by the API as for the supplier documents (0007).

create table public.vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  vehicle_id uuid not null,
  kind text not null
    check (kind in ('insurance', 'road_tax', 'registration', 'tachograph', 'other')),
  description text check (char_length(description) between 1 and 200),
  issued_on date,
  expires_on date,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (issued_on is null or expires_on is null or expires_on >= issued_on),
  constraint vehicle_documents_company_id_id_key unique (company_id, id),
  -- The document belongs to the vehicle: it goes with it (its deadline still stops the
  -- deletion of the vehicle, as for the next maintenance).
  foreign key (company_id, vehicle_id) references public.vehicles (company_id, id)
    on delete cascade
);
create index vehicle_documents_vehicle_idx on public.vehicle_documents (vehicle_id);

alter table public.vehicle_documents enable row level security;

create policy vehicle_documents_select on public.vehicle_documents
  for select using (company_id = app.current_company_id());
create policy vehicle_documents_insert on public.vehicle_documents
  for insert with check (company_id = app.current_company_id());
create policy vehicle_documents_update on public.vehicle_documents
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy vehicle_documents_delete on public.vehicle_documents
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.vehicle_documents to gestionale_app;

alter table public.deadlines
  add column vehicle_document_id uuid,
  add constraint deadlines_vehicle_document_key unique (vehicle_document_id),
  add constraint deadlines_vehicle_document_fkey foreign key (company_id, vehicle_document_id)
    references public.vehicle_documents (company_id, id) on delete cascade;
