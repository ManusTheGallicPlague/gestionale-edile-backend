-- Material returned from a site to the warehouse: a load (movement in) from that site,
-- without its own cost. It is valued at the item's average cost up to its day and is
-- subtracted from the warehouse materials of the site.
-- Same table, same row level security and privileges as before.

alter table public.warehouse_movements
  add column site_return boolean not null default false,
  add constraint warehouse_movements_site_return_check
    check (not site_return or (kind = 'in' and site_id is not null and unit_cost_cents is null));
