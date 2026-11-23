export const up = (pgm) =>
  pgm.sql(`
CREATE FUNCTION public.lock_map_initial_snapshots_for_deletion()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  LOCK TABLE ONLY public.map_initial_snapshots IN EXCLUSIVE MODE;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_map_initial_snapshots_for_deletion() FROM PUBLIC;
`);

export const down = (pgm) =>
  pgm.sql("DROP FUNCTION public.lock_map_initial_snapshots_for_deletion()");
