-- Version of an estimate's tree (chapters, items, measurements), separate from the header's
-- version: every change inside the tree bumps it, and the bulk rearrangement of the tree
-- requires it in If-Match, so it never overwrites a tree the user has not seen.

alter table public.estimates add column structure_version integer not null default 1;
