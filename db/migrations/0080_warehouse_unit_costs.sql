-- Unit cost of a load (movement in), in integer cents, without VAT: it gives each item a
-- weighted average cost and the stock a value. Unloads carry no cost.
-- Same table, same row level security and privileges as before.

alter table public.warehouse_movements
  add column unit_cost_cents bigint,
  add constraint warehouse_movements_unit_cost_check
    check (unit_cost_cents is null or (unit_cost_cents >= 0 and kind = 'in'));
