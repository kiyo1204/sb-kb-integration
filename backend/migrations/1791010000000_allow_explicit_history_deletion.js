export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE research_identity.deletion_authorizations(transaction_id bigint NOT NULL,map_id uuid NOT NULL,PRIMARY KEY(transaction_id,map_id));
CREATE OR REPLACE FUNCTION reject_map_history_boundary_change() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM research_identity.deletion_authorizations WHERE transaction_id=txid_current() AND map_id=OLD.map_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Map history boundary is immutable outside explicit deletion' USING ERRCODE='23514';
END; $$ LANGUAGE plpgsql;
`);
export const down = () => {
  throw new Error("Explicit data management required");
};
