\set ON_ERROR_STOP on
\if :{?expected_database}
\else
  \echo 'expected_database is required'
  SELECT 1/0;
\endif
\if :{?expected_migration_count}
\else
  \echo 'expected_migration_count must be 50 or 51'
  SELECT 1/0;
\endif
SELECT current_database() = :'expected_database' AS database_matches \gset
\if :database_matches
\else
  \echo 'unexpected database'
  SELECT 1/0;
\endif
SELECT :'expected_migration_count' IN ('50', '51') AS migration_count_valid \gset
\if :migration_count_valid
\else
  \echo 'expected_migration_count must be 50 or 51'
  SELECT 1/0;
\endif
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\ir migration-history-compare-950b0be.sql
COMMIT;
