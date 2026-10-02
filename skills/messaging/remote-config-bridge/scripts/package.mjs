/** Portable code-only archive. Never reads a bridge store or configuration. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import crypto from 'node:crypto';
export const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FILES=Object.freeze([
  'SKILL.md','package.json','agents/openai.yaml',
  'scripts/adapter.mjs','scripts/bridge.mjs','scripts/core.mjs','scripts/package.mjs','scripts/validate.mjs',
  'references/protocol.md','references/orchestration.md','references/orchestration-example.json','references/upstream.json',
  'tests/bridge.test.mjs','tests/orchestration.test.mjs',
]);
export function makePackage(output) {
  output=path.resolve(output);const relative=path.relative(fs.realpathSync(ROOT),path.resolve(fs.realpathSync(path.dirname(output)),path.basename(output)));
  if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Package output must be outside the skill');
  if(fs.existsSync(output))throw Error('Output already exists');
  const chunks=[];
  for(const file of FILES){
    const source=path.join(ROOT,file);if(!fs.lstatSync(source).isFile())throw Error('Package input must be a regular file');
    const data=fs.readFileSync(source),header=Buffer.alloc(512),name='remote-config-bridge/'+file;
    if(Buffer.byteLength(name)>100)throw Error('Archive path too long');header.write(name);
    const oct=(at,length,value)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',at,length);
    oct(100,8,0o644);oct(108,8,0);oct(116,8,0);oct(124,12,data.length);oct(136,12,0);
    header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);
    header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));const archive=gzipSync(Buffer.concat(chunks),{mtime:0});
  fs.writeFileSync(output,archive,{flag:'wx',mode:0o600});
  return {output,sha256:crypto.createHash('sha256').update(archive).digest('hex'),files:FILES.length,size_bytes:archive.length};
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output')throw Error('Use --output PATH');fs.mkdirSync(path.dirname(path.resolve(args[1])),{recursive:true});console.log(JSON.stringify(makePackage(args[1])));}
  catch(error){console.error(error.message);process.exitCode=2;}
}
