-- Nature of an invoice without VAT (codes of the Italian e-invoice), e.g. N6.3 for the
-- invoice of a subcontractor under reverse charge. Only an invoice with zero VAT may carry
-- one; it stays optional.

alter table public.invoices
  add column vat_nature text check (vat_nature in (
    'N1', 'N2.1', 'N2.2', 'N3.1', 'N3.2', 'N3.3', 'N3.4', 'N3.5', 'N3.6', 'N4', 'N5',
    'N6.1', 'N6.2', 'N6.3', 'N6.4', 'N6.5', 'N6.6', 'N6.7', 'N6.8', 'N6.9', 'N7')),
  add constraint invoices_vat_nature_zero_vat check (vat_nature is null or vat_cents = 0);
