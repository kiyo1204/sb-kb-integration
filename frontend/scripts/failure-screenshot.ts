import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
export async function withFailureScreenshot(work:()=>Promise<unknown>,capture:(path:string)=>Promise<unknown>) {
  try {await work();}
  catch(original) {
    try {
      const directory=process.env.VISUALIZATION_DIR??join(tmpdir(),"sbkb-browser-diagnostics");
      await mkdir(directory,{recursive:true});
      await capture(join(directory,"analysis-panel-failure.png"));
    } catch { /* Diagnostics must never replace the original failure. */ }
    throw original;
  }
}
