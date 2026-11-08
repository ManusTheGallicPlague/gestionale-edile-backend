-- Documents of employees that expire: fitness for the job from the company doctor, safety
-- training, first aid, fire safety, licences for cranes and platforms. A document with an
-- expiry becomes a real deadline of the employee, kept in step by the API as for the vehicle
-- documents (0074).

create table public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  employee_id uuid not null,
  kind text not null
    check (kind in ('medical_check', 'safety_training', 'first_aid', 'fire_safety', 'license',
                    'other')),
  description text check (char_length(description) between 1 and 200),
  issued_on date,
  expires_on date,
  notes text check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (issued_on is null or expires_on is null or expires_on >= issued_on),
  constraint employee_documents_company_id_id_key unique (company_id, id),
  -- The document belongs to the employee: it goes with them (its deadline still stops the
  -- deletion of the employee, as for the other deadlines of the employee).
  foreign key (company_id, employee_id) references public.employees (company_id, id)
    on delete cascade
);
create index employee_documents_employee_idx on public.employee_documents (employee_id);

alter table public.employee_documents enable row level security;

create policy employee_documents_select on public.employee_documents
  for select using (company_id = app.current_company_id());
create policy employee_documents_insert on public.employee_documents
  for insert with check (company_id = app.current_company_id());
create policy employee_documents_update on public.employee_documents
  for update using (company_id = app.current_company_id())
  with check (company_id = app.current_company_id());
create policy employee_documents_delete on public.employee_documents
  for delete using (company_id = app.current_company_id());

grant select, insert, update, delete on public.employee_documents to gestionale_app;

alter table public.deadlines
  add column employee_document_id uuid,
  add constraint deadlines_employee_document_key unique (employee_document_id),
  add constraint deadlines_employee_document_fkey foreign key (company_id, employee_document_id)
    references public.employee_documents (company_id, id) on delete cascade;
