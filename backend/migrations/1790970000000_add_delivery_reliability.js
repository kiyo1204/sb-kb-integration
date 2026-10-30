export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE client_event_receipts(
 session_id uuid NOT NULL REFERENCES sessions(id), client_id uuid NOT NULL, event_key uuid NOT NULL,
 client_sequence bigint NOT NULL CHECK(client_sequence>0), request_hash text NOT NULL,
 event_id uuid NOT NULL REFERENCES research_events(event_id), sequence_number bigint NOT NULL,
 PRIMARY KEY(session_id,event_key), UNIQUE(session_id,client_id,client_sequence));
CREATE TABLE client_delivery_reports(
 session_id uuid NOT NULL REFERENCES sessions(id), client_id uuid NOT NULL, report_sequence bigint NOT NULL CHECK(report_sequence>0),
 pending integer NOT NULL CHECK(pending BETWEEN 0 AND 1000000000), retrying integer NOT NULL CHECK(retrying BETWEEN 0 AND pending), acknowledged integer NOT NULL CHECK(acknowledged BETWEEN 0 AND 1000000000),
 attempts integer NOT NULL CHECK(attempts BETWEEN 0 AND 1000000000), last_response text NOT NULL CHECK(last_response IN ('NONE','ACK','NETWORK','RETRYABLE','REJECTED')),
 capacity_lost integer NOT NULL CHECK(capacity_lost BETWEEN 0 AND 1000000000), expired_lost integer NOT NULL CHECK(expired_lost BETWEEN 0 AND 1000000000), rejected_lost integer NOT NULL CHECK(rejected_lost BETWEEN 0 AND 1000000000), storage_lost integer NOT NULL CHECK(storage_lost BETWEEN 0 AND 1000000000),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(session_id,client_id));
CREATE TABLE operation_receipts(
 principal_scope text NOT NULL, operation_key uuid NOT NULL, request_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(principal_scope,operation_key));
`);
export const down = () => {
  throw new Error("Delivery receipts must be retained");
};
