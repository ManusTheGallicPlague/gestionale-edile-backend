-- Credit-based licence for construction sites (patente a crediti): a document every company
-- and self-employed worker on a site must have, kept with the other documents of the supplier.

alter table public.supplier_documents drop constraint supplier_documents_kind_check;
alter table public.supplier_documents add constraint supplier_documents_kind_check
  check (kind in ('durc', 'chamber_extract', 'insurance', 'credit_license', 'other'));
