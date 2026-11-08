-- Next maintenance of a vehicle: a job can say when the next one is due (the next service,
-- the next inspection). The date becomes a real deadline of the vehicle, kept in step by the
-- API as for the supplier documents (0007); deleting the job deletes its deadline.

alter table public.vehicle_maintenances
  add column next_due_on date,
  add constraint vehicle_maintenances_next_due_check check (next_due_on > performed_on),
  add constraint vehicle_maintenances_company_id_id_key unique (company_id, id);

alter table public.deadlines
  add column vehicle_maintenance_id uuid,
  add constraint deadlines_vehicle_maintenance_key unique (vehicle_maintenance_id),
  add constraint deadlines_vehicle_maintenance_fkey foreign key (company_id, vehicle_maintenance_id)
    references public.vehicle_maintenances (company_id, id) on delete cascade;
