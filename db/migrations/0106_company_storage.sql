-- Space taken by the files of the declared company, for its storage limit: site documents
-- and photos, the files of supplier, vehicle and employee documents, invoice files and the
-- logo. Security definer, so the sum counts every file of the company whatever the user may
-- read, and only that company: app.current_company_id() is null for who is not a member.
-- The sizes are the ones stored with the files (checked equal to the data where both exist).

create function app.company_storage_bytes() returns bigint
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select
    coalesce((select sum(size_bytes) from public.site_documents
              where company_id = app.current_company_id()), 0)
    + coalesce((select sum(size_bytes) from public.supplier_document_files
                where company_id = app.current_company_id()), 0)
    + coalesce((select sum(size_bytes) from public.vehicle_document_files
                where company_id = app.current_company_id()), 0)
    + coalesce((select sum(size_bytes) from public.employee_document_files
                where company_id = app.current_company_id()), 0)
    + coalesce((select sum(size_bytes) from public.invoice_files
                where company_id = app.current_company_id()), 0)
    + coalesce((select sum(octet_length(data)) from public.company_logos
                where company_id = app.current_company_id()), 0)
$$;
revoke all on function app.company_storage_bytes() from public;
grant execute on function app.company_storage_bytes() to gestionale_app;
