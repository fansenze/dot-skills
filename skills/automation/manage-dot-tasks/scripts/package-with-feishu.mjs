#!/usr/bin/env node
/** Repository/paired-export maintenance only; never configures or starts services. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {skill_entries,package_entries} from './package.mjs';
import {canonical_path,is_main,require_node,TaskError} from './taskctl.mjs';
const root=canonical_path(fileURLToPath(new URL('..',import.meta.url)));
export async function package_with_feishu(target, serverRoot, bridgeRoot) {
  require_node();
  serverRoot=canonical_path(serverRoot??[path.resolve(root,'../../messaging/feishu-message-server'),path.resolve(root,'../feishu-message-server')].find(p=>fs.existsSync(path.join(p,'scripts/package.mjs')))??'');
  bridgeRoot=canonical_path(bridgeRoot??path.resolve(serverRoot,'../remote-config-bridge'));
  target=canonical_path(target);
  for(const source of [root,serverRoot,bridgeRoot]) { const rel=path.relative(source,target);if(!rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))) throw new TaskError('combined output must be outside all bundled skills'); }
  const {FILES,portableMetadata}=await import(pathToFileURL(path.join(serverRoot,'scripts/package.mjs')).href);
  const {FILES:bridgeFiles}=await import(pathToFileURL(path.join(bridgeRoot,'scripts/package.mjs')).href);
  const {stringify}=createRequire(path.join(serverRoot,'package.json'))('yaml');
  const entries=skill_entries();
  for(const rel of FILES) { const source=path.join(serverRoot,rel);if(!fs.lstatSync(source).isFile()) throw new TaskError('Feishu export input must be a regular file');entries.push({name:'feishu-message-server/'+rel,data:fs.readFileSync(source),mode:rel==='feishu.sh'?0o100755:0o100644}); }
  const meta=portableMetadata();entries.find(e=>e.name==='feishu-message-server/package.json').data=Buffer.from(JSON.stringify(meta.pkg,null,2)+'\n');
  entries.push({name:'feishu-message-server/pnpm-lock.yaml',data:Buffer.from(stringify(meta.lock))});
  for(const rel of bridgeFiles) { const source=path.join(bridgeRoot,rel);if(!fs.lstatSync(source).isFile()) throw new TaskError('Bridge export input must be a regular file');entries.push({name:'remote-config-bridge/'+rel,data:fs.readFileSync(source)}); }
  entries.push({name:'README.txt',data:fs.readFileSync(path.join(root,'references/bundle-readme.txt'))});
  entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  const manifest={bundle:'manage-dot-tasks-with-feishu',protocol_version:1,files:entries.map(e=>({path:e.name,bytes:e.data.length,sha256:crypto.createHash('sha256').update(e.data).digest('hex')}))};
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
  manifest.source_revision={base_commit:revision.status===0?revision.stdout.trim():null,packaged_tree_sha256:crypto.createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'),note:'Packaged file hashes identify the exported working tree; base_commit alone does not imply these edits are committed.'};
  entries.push({name:'MANIFEST.json',data:Buffer.from(JSON.stringify(manifest,null,2)+'\n')});
  return package_entries(target,entries);
}
if(is_main(import.meta.url)) {
  try { if(process.argv.length<3||process.argv.length>5) throw new TaskError('Usage: node package-with-feishu.mjs OUTPUT.zip [FEISHU_SKILL_DIR] [BRIDGE_SKILL_DIR]');console.log(JSON.stringify(await package_with_feishu(process.argv[2],process.argv[3],process.argv[4]),null,2)); }
  catch(error) {console.error('combined package: '+error.message);process.exitCode=2;}
}
