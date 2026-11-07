-- Position of a site on the map (WGS 84, as used by OpenStreetMap): both coordinates or none.
-- The table already has RLS and the grants for gestionale_app; the new columns follow them.

alter table public.sites add column latitude numeric(8, 6);
alter table public.sites add column longitude numeric(9, 6);
alter table public.sites add constraint sites_location_check check (
  (latitude is null) = (longitude is null)
  and latitude between -90 and 90
  and longitude between -180 and 180
);
