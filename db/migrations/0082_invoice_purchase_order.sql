-- A received invoice can bill a purchase order sent to the same supplier: the office checks
-- the invoice against what was ordered. An order can be billed by several invoices (deliveries
-- invoiced one by one), an invoice bills at most one order.
-- Only draft orders can be deleted and a draft is never linked, so a billed order stays; the
-- check is deferred when a whole company is deleted, as in 0054.
-- The column sits on a table already under RLS: no new policy or privilege is needed.

alter table public.invoices
  add column purchase_order_id uuid,
  add constraint invoices_purchase_order_fkey foreign key (company_id, purchase_order_id)
    references public.purchase_orders (company_id, id) deferrable initially immediate,
  add constraint invoices_purchase_order_received_check
    check (purchase_order_id is null or direction = 'received');

create index invoices_purchase_order_idx on public.invoices (purchase_order_id)
  where purchase_order_id is not null;

create function app.defer_invoice_purchase_order_check() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  set constraints public.invoices_purchase_order_fkey deferred;
  return old;
end
$$;

create trigger companies_defer_invoice_purchase_order_check before delete on public.companies
  for each row execute function app.defer_invoice_purchase_order_check();
