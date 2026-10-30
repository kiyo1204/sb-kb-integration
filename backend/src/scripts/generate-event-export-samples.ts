import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sampleFiles } from "../event-export-samples.js";
const dir = "../docs/samples/event-export";
await mkdir(dir, { recursive: true });
for (const [name, text] of Object.entries(sampleFiles()))
  await writeFile(join(dir, name), text, "utf8");
console.log("Dummy export samples generated; no database connection.");
