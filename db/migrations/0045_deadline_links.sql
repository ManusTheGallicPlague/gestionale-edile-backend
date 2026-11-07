-- Deadlines can also point to a site, an employee or a vehicle of the same company
-- (medical checks and safety training of an employee, inspection and road tax of a vehicle,
-- permits of a site), and two new kinds cover the employees: medical_check and training.
-- A site, employee or vehicle with deadlines cannot be deleted (409 has_documents); the
-- checks are deferred when a whole company is deleted, as in 0038.

alter table public.deadlines
  add column site_id uuid,
  add column employee_id uuid,
  add column vehicle_id uuid,
  add constraint deadlines_site_fkey foreign key (company_id, site_id)
    references public.sites (company_id, id) deferrable initially immediate,
  add constraint deadlines_employee_fkey foreign key (company_id, employee_id)
    references public.employees (company_id, id) deferrable initially immediate,
  add constraint deadlines_vehicle_fkey foreign key (company_id, vehicle_id)
    references public.vehicles (company_id, id) deferrable initially immediate;

create index deadlines_site_idx on public.deadlines (site_id) where site_id is not null;
create index deadlines_employee_idx on public.deadlines (employee_id)
  where employee_id is not null;
create index deadlines_vehicle_idx on public.deadlines (vehicle_id) where vehicle_id is not null;

alter table public.deadlines drop constraint deadlines_kind_check;
alter table public.deadlines add constraint deadlines_kind_check
  check (kind in ('durc', 'insurance', 'tax', 'invoice_in', 'invoice_out', 'contract',
                  'vehicle', 'medical_check', 'training', 'other'));

create function app.defer_deadline_link_checks() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  set constraints public.deadlines_site_fkey, public.deadlines_employee_fkey,
    public.deadlines_vehicle_fkey deferred;
  return old;
end
$$;

create trigger companies_defer_deadline_link_checks before delete on public.companies
  for each row execute function app.defer_deadline_link_checks();
