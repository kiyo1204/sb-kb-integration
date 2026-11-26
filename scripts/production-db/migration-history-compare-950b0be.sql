-- Read-only caller-owned transaction fragment. Caller sets expected_migration_count (50 or 51).
\ir approved-migration-history-950b0be.sql
WITH expected(position, name) AS (VALUES :approved_migration_rows),
actual AS (
  SELECT row_number() OVER (ORDER BY run_on, id)::integer AS position, name
  FROM public.pgmigrations
),
mismatch AS (
  SELECT 'missing_or_out_of_order'::text AS kind, e.position, e.name
  FROM expected e
  WHERE e.position <= :expected_migration_count::integer
    AND NOT EXISTS (SELECT FROM actual a WHERE a.position=e.position AND a.name=e.name)
  UNION ALL
  SELECT 'unexpected_or_out_of_order'::text, a.position, a.name
  FROM actual a
  WHERE NOT EXISTS (SELECT FROM expected e WHERE e.position=a.position AND e.name=a.name AND e.position<=:expected_migration_count::integer)
)
SELECT kind, position, name FROM mismatch ORDER BY position, kind;
SELECT count(*) AS actual_migration_count FROM public.pgmigrations \gset
\echo expected_migration_count=:expected_migration_count
\echo actual_migration_count=:actual_migration_count
WITH expected(position, name) AS (VALUES :approved_migration_rows),
actual AS (
  SELECT row_number() OVER (ORDER BY run_on, id)::integer AS position, name
  FROM public.pgmigrations
),
mismatch AS (
  SELECT e.position
  FROM expected e
  WHERE e.position <= :expected_migration_count::integer
    AND NOT EXISTS (SELECT FROM actual a WHERE a.position=e.position AND a.name=e.name)
  UNION ALL
  SELECT a.position
  FROM actual a
  WHERE NOT EXISTS (SELECT FROM expected e WHERE e.position=a.position AND e.name=a.name AND e.position<=:expected_migration_count::integer)
)
SELECT count(*) AS migration_mismatch_count FROM mismatch \gset
SELECT :actual_migration_count::integer = :expected_migration_count::integer AND :migration_mismatch_count::integer = 0 AS migration_history_exact \gset
\if :migration_history_exact
  \echo MIGRATION_HISTORY=PASS
\else
  \echo MIGRATION_HISTORY=FAIL
  SELECT 1/0;
\endif
