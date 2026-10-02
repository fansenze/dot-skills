import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {ROOT,FILES} from './package.mjs';
import {fileHash} from './core.mjs';
const skill=fs.readFileSync(path.join(ROOT,'SKILL.md'),'utf8');
assert.match(skill,/^---\nname: remote-config-bridge\ndescription: [^\n]+\n---\n/);
const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
assert.equal(pkg.name,'remote-config-bridge-skill');assert.ok(!pkg.dependencies&&!pkg.devDependencies);
const metadata=fs.readFileSync(path.join(ROOT,'agents/openai.yaml'),'utf8');assert.ok(metadata.includes('$remote-config-bridge'));
const provenance=JSON.parse(fs.readFileSync(path.join(ROOT,'references/upstream.json'),'utf8'));
assert.equal(fileHash(path.join(ROOT,'scripts/core.mjs')),provenance.core_sha256,'Preserve the accepted locking core; review any intentional upstream update');
for(const name of FILES) {
  const file=path.join(ROOT,name);assert.ok(fs.lstatSync(file).isFile(),name);
  assert.ok(!/\.(?:py|pyc|sh)$/.test(name),'Authored scripts must be Node-only');
  const content=fs.readFileSync(file,'utf8');
  assert.ok(!/\/Users\/[^/]+\/|\/home\/[^/]+\//.test(content),'Do not package real machine paths');
  if(name.endsWith('.mjs')){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
  if(name.endsWith('.md')) for(const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target=match[1].split('#')[0];if(target&&!/^\w+:/.test(target)) assert.ok(fs.existsSync(path.resolve(path.dirname(file),target)),`Missing portable reference: ${target}`);
  }
}
console.log(JSON.stringify({ok:true,skill:'remote-config-bridge',node:process.versions.node,portable_files:FILES.length}));
