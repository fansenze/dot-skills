import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../scripts/config.mjs';
import {FILES,ARCHIVE_FILES,makePackage} from '../scripts/package.mjs';
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
test('portable routing chooses the requested service host and keeps credential handoff separate',()=>{
  const skill=read('SKILL.md'),recipe=read('references/remote-configuration.md'),operations=read('references/operations.md');
  assert.match(skill,/Only explicitly requested computer hosting routes through/);
  assert.match(recipe,/Configuration source location does not choose the service host/);
  assert.match(recipe,/secure_configuration_handoff_required/);
  assert.match(recipe,/no upload, receiver startup or bridge fallback/);
  assert.match(recipe,/No skill can waive platform credential restrictions/);
  assert.match(recipe,/test-purpose credentials/);
  assert.match(recipe,/compare the actual installed files with the requested repository revision/i);
  assert.match(recipe,/Use the same roots for checks/);
  const local=recipe.split('Local task only:')[1].split('Dot only:')[0];
  for(const command of ['check','identity','capabilities','start']) assert.ok(local.includes('"$LOCAL_SERVER" '+command));
  const dot=recipe.split('Dot only:')[1].split('## Bounded operation')[0];
  assert.doesNotMatch(dot,/\$LOCAL_CONFIG|\$LOCAL_SERVER|--config/);
  assert.match(dot,/remote-config-bridge|\$DOT_BRIDGE\/scripts\/adapter\.mjs/);
  assert.match(recipe,/must not call the Feishu setup skill or bridge skill recursively/);
  for(const tool of ['cloud_threads.create','cloud_threads.send_message','cloud_threads.read']) assert.ok(recipe.includes(tool));
  assert.match(recipe,/only `send`, `reply` and bounded `receive`/);
  assert.match(recipe,/late successful receipt reconciles the existing unknown notice/i);
  assert.match(operations,/Only explicitly requested computer hosting follows/);
  assert.ok(FILES.includes('references/remote-configuration.md'));assert.ok(FILES.includes('tests/routing.test.mjs'));
});

function temporary(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-routing-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;
}
const block=marker=>read('references/remote-configuration.md').split(`<!-- ${marker} -->`)[1].match(/```bash\n([\s\S]*?)```/)[1];
function directChecks(config,cwd) {
  const results=[];
  for(const line of block('dot-service-checks').trim().split('\n')) {
    const match=line.match(/^node "\$FEISHU_SKILL\/scripts\/server\.mjs" (check|identity|capabilities)( --config "\$SERVICE_CONFIG")?$/);
    assert.ok(match,'Documented commands must use the pinned absolute runtime');
    const args=[path.join(ROOT,'scripts/server.mjs'),match[1],...(match[2]?['--config',config]:[])];
    const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:10000});
    results.push(result);if(result.status!==0)break;
  }
  return results;
}
for(const scenario of ['Mac source with dot configuration already provisioned','existing dot configuration']) {
  test(`documented direct checks: ${scenario}`,t=>{
    const dir=temporary(t),dot=path.join(dir,'dot with spaces');fs.mkdirSync(dot);
    const config=path.join(dot,'service.yml'),yaml='app_id: "cli_0000000000000000"\napp_secret: "synthetic-only"\n';
    // Fixture provisioning is not a production credential-transfer mechanism.
    fs.writeFileSync(config,yaml);
    const source=path.join(dir,'mac-source.yml');
    if(scenario.startsWith('Mac'))fs.writeFileSync(source,'source-only synthetic fixture');
    const results=directChecks(config,dot);assert.equal(results.length,3);
    for(const result of results){assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes('synthetic-only'));}
    assert.equal(JSON.parse(results[1].stdout).brand,'feishu');
    assert.equal(fs.readFileSync(config,'utf8'),yaml);
    if(fs.existsSync(source))assert.equal(fs.readFileSync(source,'utf8'),'source-only synthetic fixture');
    assert.deepEqual(fs.readdirSync(dot),['service.yml']); // No receiver/worker state.
  });
}
test('missing dot configuration stops checks without using an available Mac source',t=>{
  const dir=temporary(t),source=path.join(dir,'mac.yml');
  fs.writeFileSync(source,'app_id: "cli_0000000000000000"\napp_secret: "synthetic-only"\n');
  const results=directChecks(path.join(dir,'missing-dot.yml'),dir);
  assert.equal(results.length,1);assert.notEqual(results[0].status,0);
  assert.equal(JSON.parse(results[0].stdout).ok,false);assert.deepEqual(fs.readdirSync(dir),['mac.yml']);
});
test('an older installation in cwd cannot replace the pinned runtime in the recipe',t=>{
  const old=temporary(t),marker=path.join(old,'old-runtime-called');fs.mkdirSync(path.join(old,'scripts'));
  fs.writeFileSync(path.join(old,'scripts/server.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(9);`);
  const config=path.join(old,'fixture.yml');fs.writeFileSync(config,'app_id: "cli_0000000000000000"\napp_secret: "synthetic-only"\n');
  assert.notDeepEqual(fs.readFileSync(path.join(old,'scripts/server.mjs')),fs.readFileSync(path.join(ROOT,'scripts/server.mjs')));
  const results=directChecks(config,old);assert.equal(results.length,3);
  assert.ok(results.every(r=>r.status===0));assert.ok(!fs.existsSync(marker));
});
test('documented toolchain check rejects old child pnpm despite a correct parent invocation',t=>{
  const dir=temporary(t),old=path.join(dir,'old-bin'),pinned=path.join(dir,'node_modules/.bin');
  fs.mkdirSync(old);fs.mkdirSync(pinned,{recursive:true});
  for(const [bin,version] of [[old,'11.19.0'],[pinned,'11.27.0']])fs.writeFileSync(path.join(bin,'pnpm'),`#!${process.execPath}\nconsole.log('${version}');\n`,{mode:0o700});
  const parent=path.join(dir,'pnpm.cjs');fs.writeFileSync(parent,"console.log('11.27.0');\n");
  const environment={...process.env,PATH:old+path.delimiter+process.env.PATH};
  assert.equal(spawnSync(process.execPath,[parent,'--version'],{env:environment,encoding:'utf8'}).stdout.trim(),'11.27.0');
  const recipe=block('runtime-toolchain-check'),check=recipe.match(/node -e '([^']+)'/)[1];
  assert.match(recipe,/export PATH="\$PNPM_BIN:\$PATH"/);
  const wrong=spawnSync(process.execPath,['-e',check],{env:environment,encoding:'utf8'});
  assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/got 11\.19\.0/);
  const correct=spawnSync(process.execPath,['-e',check],{env:{...environment,PATH:pinned+path.delimiter+environment.PATH},encoding:'utf8'});
  assert.equal(correct.status,0,correct.stderr);assert.equal(correct.stdout.trim(),'11.27.0');
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
