\set ON_ERROR_STOP on
\if :{?expected_database}
\else
  \echo 'expected_database is required'
  SELECT 1/0;
\endif
\if :{?apply_revoke}
\else
  \set apply_revoke 0
\endif
SELECT current_database() = :'expected_database' AS database_matches \gset
\if :database_matches
\else
  \echo 'unexpected database'
  SELECT 1/0;
\endif
SELECT :'apply_revoke' IN ('0', '1') AS apply_revoke_valid \gset
\if :apply_revoke_valid
\else
  \echo 'apply_revoke must be 0 or 1'
  SELECT 1/0;
\endif

\if :apply_revoke
  BEGIN;
  SET LOCAL search_path = pg_catalog, pg_temp;
  SELECT format(
    'REVOKE CREATE ON DATABASE %I FROM sbkb_prod_migrator',
    current_database()
  ) \gexec
  COMMIT;
\endif

SELECT NOT has_database_privilege(
  'sbkb_prod_migrator', current_database(), 'CREATE'
) AS migrator_create_revoked \gset
\if :migrator_create_revoked
  \echo MIGRATOR_DATABASE_CREATE=REVOKED
\else
  \echo MIGRATOR_DATABASE_CREATE=UNEXPECTED_EFFECTIVE_CREATE
  SELECT 1/0;
\endif
