export const up = (pgm) =>
  pgm.sql(`
ALTER TABLE client_delivery_reports DROP CONSTRAINT client_delivery_reports_last_response_check;
ALTER TABLE client_delivery_reports ADD CONSTRAINT client_delivery_reports_last_response_check
 CHECK(last_response IN ('NONE','ACK','NETWORK','RETRYABLE','REJECTED','STORAGE'));
`);
export const down = () => {
  throw new Error("Delivery status meaning must be retained");
};
