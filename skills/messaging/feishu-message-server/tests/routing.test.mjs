import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {ROOT} from '../scripts/config.mjs';
import {FILES,ARCHIVE_FILES,makePackage} from '../scripts/package.mjs';
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
test('portable configuration recipe routes remote paths once and keeps all server commands on their owner',()=>{
  const skill=read('SKILL.md'),recipe=read('references/remote-configuration.md'),operations=read('references/operations.md');
  assert.match(skill,/Route remote configuration through remote-config-bridge/);
  assert.match(skill,/Stop this direct setup flow after delegation/);
  assert.doesNotMatch(skill,/Transfer local configuration to dot|transfer-local-files-to-dot/);
  assert.match(recipe,/Same-environment\/local-only configuration uses the Feishu CLI directly/);
  const local=recipe.split('Local task only:')[1].split('Dot only:')[0];
  for(const command of ['check','identity','capabilities','start']) assert.ok(local.includes('"$LOCAL_SERVER" '+command));
  const dot=recipe.split('Dot only:')[1].split('## Bounded operation')[0];
  assert.doesNotMatch(dot,/\$LOCAL_CONFIG|\$LOCAL_SERVER|--config/);
  assert.match(dot,/remote-config-bridge|\$DOT_BRIDGE\/scripts\/adapter\.mjs/);
  assert.match(recipe,/must not call the Feishu setup skill or bridge skill recursively/);
  for(const tool of ['cloud_threads.create','cloud_threads.send_message','cloud_threads.read']) assert.ok(recipe.includes(tool));
  assert.match(recipe,/only `send`, `reply` and bounded `receive`/);
  assert.match(recipe,/late successful receipt reconciles the existing unknown notice/i);
  assert.match(operations,/configuration is not uploaded or copied to dot/);
  assert.ok(FILES.includes('references/remote-configuration.md'));assert.ok(FILES.includes('tests/routing.test.mjs'));
});
test('raw portable tar entries contain only the allowlist without Mac metadata sidecars',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-portable-entries-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const data=gunzipSync(fs.readFileSync(makePackage(path.join(directory,'skill.tgz')))),files=[];
  const field=(offset,length)=>data.subarray(offset,offset+length).toString('utf8').split('\0')[0];
  for(let offset=0;offset+512<=data.length;){
    if(data.subarray(offset,offset+512).every(byte=>byte===0)) break;
    const name=field(offset,100),prefix=field(offset+345,155),full=prefix?prefix+'/'+name:name;
    const size=Number.parseInt(field(offset+124,12).trim()||'0',8),type=field(offset+156,1);
    assert.ok(Number.isSafeInteger(size)&&size>=0);
    assert.ok(!full.split('/').some(part=>part.startsWith('._')),full);
    if(type===''||type==='0') files.push(full.replace(/^feishu-message-server\//,''));
    offset+=512+Math.ceil(size/512)*512;
  }
  assert.deepEqual(files.sort(),[...ARCHIVE_FILES].sort());
});
