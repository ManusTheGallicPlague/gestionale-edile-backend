-- Withholding tax (ritenuta d'acconto) kept back by whoever pays the invoice: 20% on a
-- professional's fee, 4% of a condominium on contracted works. Never beyond the taxable
-- amount (amounts are not negative here); the amount due is the total minus the withholding.

alter table public.invoices
  add column withholding_cents bigint not null default 0,
  add constraint invoices_withholding_within_taxable check (
    withholding_cents between 0 and taxable_cents);
