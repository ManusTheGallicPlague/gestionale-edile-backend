-- Totals of the bill of quantities, computed by the database and never stored, so they
-- cannot drift. Item quantity = sum of its measurement rows; item amount in cents =
-- quantity × unit price, rounded to the cent (half away from zero) item by item. Chapters
-- and the estimate add up the rounded item amounts.
-- security_invoker: the view runs with the caller's privileges, so the RLS policies of
-- the underlying tables apply to it.

create view public.estimate_item_totals with (security_invoker = true) as
select
  i.id as item_id,
  i.company_id,
  i.estimate_id,
  i.chapter_id,
  coalesce(m.quantity, 0)::numeric as quantity,
  round(coalesce(m.quantity, 0) * i.unit_price_cents)::numeric as amount_cents
from public.estimate_items i
left join lateral (
  select sum(quantity) as quantity from public.estimate_measurements
  where estimate_id = i.estimate_id and item_id = i.id
) m on true;

grant select on public.estimate_item_totals to gestionale_app;
