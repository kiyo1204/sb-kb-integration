// compact JSON is checked at 4,000,000 bytes by the shared Map/event validator.
// PostgreSQL expands tiny finite numbers and inserts spaces in jsonb::text.
// This storage guard must not reject an API-valid state because of that representation.
export const up = pgm => pgm.sql(`DO $$
DECLARE definition text;
BEGIN
 definition := pg_get_functiondef('public.map_event_state_v5_valid(jsonb,uuid)'::regprocedure);
 IF position('octet_length(s::text)>4200000' in definition)=0 THEN RAISE EXCEPTION 'unexpected_v5_storage_guard'; END IF;
 EXECUTE replace(definition,'octet_length(s::text)>4200000','octet_length(s::text)>8000000');
END $$;`);
export const down = () => {throw new Error("Do not reinstate a guard that rejects valid saved states");};
