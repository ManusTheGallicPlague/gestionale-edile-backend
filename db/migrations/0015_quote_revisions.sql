-- Quote revisions: a sent quote is never changed; a revision is a new draft linked to the
-- quote it comes from. When first sent, a revision takes the same number with the next
-- revision (2026/001-R1) and uses no new number from the counter. Originals are revision 0.
-- The link is a plain (no action) foreign key: a quote with revisions is never a draft, so
-- it cannot be deleted anyway, while deleting a whole company still works.

alter table public.quotes
  add column revision integer check (revision >= 0),
  add column revision_of_id uuid;

update public.quotes set revision = 0 where number_seq is not null;

alter table public.quotes
  drop constraint quotes_company_id_number_year_number_seq_key,
  add constraint quotes_number_revision_key
    unique (company_id, number_year, number_seq, revision),
  add constraint quotes_revision_numbered check ((number_seq is null) = (revision is null)),
  add constraint quotes_revision_link
    check (revision is null or (revision = 0) = (revision_of_id is null)),
  add constraint quotes_revision_of_fkey foreign key (company_id, revision_of_id)
    references public.quotes (company_id, id);

create index quotes_revision_of_idx on public.quotes (revision_of_id);
