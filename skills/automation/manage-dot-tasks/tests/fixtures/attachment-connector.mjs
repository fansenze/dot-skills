/** Synthetic host-local attachment provider. No credentials or external calls. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createConnector as conversations} from './conversation-connector.mjs';
export function createConnector(settings) {
  const base=conversations(settings), saved=path.join(settings.root,'uploaded.json');
  return {...base,
    capabilities:()=>({...base.capabilities(),formats:['text','markdown','card','image','file'],upload:true}),
    inspectUpload:async d=>({...d,name:path.basename(d.filePath),size:fs.statSync(d.filePath).size,sha256:createHash('sha256').update(fs.readFileSync(d.filePath)).digest('hex'),...(d.kind==='file'?{file_type:'pdf'}:{})}),
    upload:async m=>{
      fs.appendFileSync(path.join(settings.root,'uploads.jsonl'),JSON.stringify(m)+'\n');
      const {kind,name,size,sha256,file_type}=m.descriptor;
      const r={status:'uploaded',idempotency_key:m.idempotency_key,resource:{upload_id:m.idempotency_key,app_id:m.account_id,brand:settings.brand,kind,name,size,sha256,...(file_type?{file_type}:{}),[kind+'_key']:'synthetic_resource_key'}};
      fs.writeFileSync(saved,JSON.stringify(r));
      if(fs.existsSync(path.join(settings.root,'unknown-upload')))throw new Error('PRIVATE upload diagnostic');
      return r;
    },
    uploadStatus:async()=>JSON.parse(fs.readFileSync(saved,'utf8')),
  };
}
