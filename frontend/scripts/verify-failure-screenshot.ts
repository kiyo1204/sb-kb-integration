import assert from "node:assert/strict";
import { withFailureScreenshot } from "./failure-screenshot";
export async function verifyFailureScreenshot() {
  const original=new Error("TEST ONLY original failure");
  let captures=0;
  await withFailureScreenshot(async()=>undefined,async()=>{captures++;});
  assert.equal(captures,0);
  await assert.rejects(withFailureScreenshot(async()=>{throw original;},async()=>{captures++;throw new Error("TEST ONLY image write failed");}),e=>e===original);
  assert.equal(captures,1);
}
