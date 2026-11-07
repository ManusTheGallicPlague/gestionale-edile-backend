-- Minimum stock of a warehouse item: below it the item is to reorder. Optional; the stock is
-- still computed from the movements. The table keeps its RLS policies and privileges.

alter table public.warehouse_items
  add column min_stock numeric(14, 3) check (min_stock is null or min_stock >= 0);
