-- Supplier documents with an expiry appear in the deadline calendar as real deadlines,
-- kept in step by the API. Deleting the document deletes its deadline.

alter table public.supplier_documents
  add constraint supplier_documents_company_id_id_key unique (company_id, id);

alter table public.deadlines
  add column supplier_document_id uuid,
  add constraint deadlines_supplier_document_key unique (supplier_document_id),
  add constraint deadlines_supplier_document_fkey foreign key (company_id, supplier_document_id)
    references public.supplier_documents (company_id, id) on delete cascade;
