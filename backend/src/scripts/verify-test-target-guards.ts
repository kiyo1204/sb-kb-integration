import assert from "node:assert/strict";
import {readdir,readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {verifyMockTestUrl} from "./mock-db.js";
for(const url of ['', 'postgres://dummy@unknown.invalid/research', 'postgres://dummy@127.0.0.1:5432/research_mvp', 'postgres://dummy@192.168.1.2:5432/stage1_mock_no', 'postgres://dummy@127.0.0.1:5432/stage1_mock_'+randomUUID().replaceAll('-','')])await assert.rejects(verifyMockTestUrl(url));
for(const name of await readdir('src/scripts')){if(!/^verify-.*\.ts$/.test(name)||name==='verify-test-target-guards.ts')continue;const source=await readFile('src/scripts/'+name,'utf8');const pool=source.indexOf('new Pool(');if(pool<0)continue;const guard=source.indexOf('await verifyMockTestUrl(');assert.ok(guard>=0&&guard<pool,name+' must verify its disposable DB before constructing a Pool');}
console.log('Test safety: unknown/existing/non-loopback targets refused before DB access; every DB verification script declares provenance guard: PASS');
