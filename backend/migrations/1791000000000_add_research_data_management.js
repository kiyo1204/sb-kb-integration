export const up = (pgm) =>
  pgm.sql(`
CREATE SCHEMA research_identity;
REVOKE ALL ON SCHEMA research_identity FROM PUBLIC;
CREATE TABLE research_studies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),retain_until timestamptz);
INSERT INTO research_studies(id) VALUES('11111111-1111-4111-8111-111111111119');
CREATE TABLE research_identity.participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),study_id uuid NOT NULL REFERENCES research_studies(id),pseudonym text UNIQUE NOT NULL DEFAULT ('P-'||gen_random_uuid()::text));
CREATE TABLE research_identity.membership(session_id uuid PRIMARY KEY REFERENCES sessions(id),participant_id uuid NOT NULL REFERENCES research_identity.participants(id));
CREATE FUNCTION research_identity.assign() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p uuid; BEGIN
INSERT INTO research_identity.participants(study_id) VALUES('11111111-1111-4111-8111-111111111119') RETURNING id INTO p;
INSERT INTO research_identity.membership VALUES(NEW.id,p);RETURN NEW;END $$;
CREATE TRIGGER assign_identity AFTER INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION research_identity.assign();
DO $$ DECLARE s record;p uuid;BEGIN FOR s IN SELECT id FROM sessions LOOP
INSERT INTO research_identity.participants(study_id) VALUES('11111111-1111-4111-8111-111111111119') RETURNING id INTO p;
INSERT INTO research_identity.membership VALUES(s.id,p);END LOOP;END $$;
CREATE VIEW research_session_ids AS SELECT m.session_id,p.pseudonym,p.study_id FROM research_identity.membership m JOIN research_identity.participants p ON p.id=m.participant_id;
CREATE TABLE research_deletion_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),session_count integer NOT NULL CHECK(session_count>0));
CREATE TABLE research_identity.revocations(token_hash text PRIMARY KEY,queue_key text NOT NULL,receipt_id uuid NOT NULL REFERENCES research_deletion_receipts(id));
CREATE TABLE research_identity.device_deletions(token_hash text NOT NULL REFERENCES research_identity.revocations(token_hash),client_hash text NOT NULL,acknowledged boolean NOT NULL DEFAULT false,PRIMARY KEY(token_hash,client_hash));
`);
export const down = () => {
  throw new Error("Explicit data management required");
};
