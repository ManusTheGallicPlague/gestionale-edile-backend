-- Progress statements keep their estimate and their items: an estimate with statements, or
-- an item with lines in a statement, cannot be deleted (the API answers 409 has_documents).
-- "No action" rather than "restrict": the check runs at the end of the statement, so
-- deleting a whole company, which removes statements and items together, still works.

alter table public.progress_statements
  drop constraint progress_statements_company_id_estimate_id_fkey,
  add constraint progress_statements_estimate_fkey
    foreign key (company_id, estimate_id) references public.estimates (company_id, id);

alter table public.progress_statement_lines
  drop constraint progress_statement_lines_company_id_estimate_id_item_id_fkey,
  add constraint progress_statement_lines_item_fkey
    foreign key (company_id, estimate_id, item_id)
    references public.estimate_items (company_id, estimate_id, id);
