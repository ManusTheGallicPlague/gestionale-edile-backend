-- Loads from received purchase orders: a movement in may point to the order it comes from.
-- An order with loads keeps them: it cannot go back from received (the API answers 409).

alter table public.warehouse_movements
  add column purchase_order_id uuid,
  add constraint warehouse_movements_order_fkey
    foreign key (company_id, purchase_order_id)
    references public.purchase_orders (company_id, id) on delete restrict,
  add constraint warehouse_movements_order_in_check
    check (purchase_order_id is null or kind = 'in');
create index warehouse_movements_order_idx on public.warehouse_movements (purchase_order_id)
  where purchase_order_id is not null;
