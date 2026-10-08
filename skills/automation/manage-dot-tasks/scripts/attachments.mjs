/** Durable upload intents, separate from message outbox intents. No payload bytes. */
import {digest,requireText,loadConnector,bounded,ConnectorError} from './connectors/contract.mjs';

export const ATTACHMENT_OPTIONS = {
  'attachment-upload':['id','connector','path','allowed-root','kind','authorization-ref'],
  'attachment-status':['id'], 'attachment-reconcile':['id'],
  'attachment-reply':['id','resource-id','inbound-id','authorization-ref']
};
const fail = message => { throw new ConnectorError(message); };
export function validateUploads(data) {
  if (data.uploads === undefined) return;
  if (!Array.isArray(data.uploads) || new Set(data.uploads.map(u=>u.id)).size !== data.uploads.length) fail('Invalid upload ledger');
  for (const u of data.uploads) {
    if (!u.id || !data.connections.some(c=>c.binding===u.binding&&c.id===u.connector) || !['uploading','uploaded','upload_unknown','not_uploaded','api_error'].includes(u.state) || u.key!=='upload-'+digest([u.id,u.binding]).slice(0,40) || !/^[a-f0-9]{64}$/.test(u.descriptor?.sha256) || !['image','file'].includes(u.descriptor?.kind)) fail('Invalid upload record');
    if(u.state==='uploaded'&&checked(u.receipt,u).status!=='uploaded')fail('Invalid upload receipt');
  }
}
function checked(raw,u) {
  const unknown = {status:'upload_unknown',idempotency_key:u.key,error_code:'invalid-upload-result'};
  if (!raw || raw.idempotency_key!==u.key || !['uploaded','upload_unknown','not_uploaded','api_error'].includes(raw.status)) return unknown;
  const result = {status:raw.status,idempotency_key:u.key};
  if (raw.status==='uploaded') {
    const r=raw.resource,d=u.descriptor;
    if (!r || r.upload_id!==u.key || r.app_id!==u.account || r.brand!==u.brand || ['kind','sha256','size','name','file_type'].some(k=>r[k]!==d[k]) || typeof r[d.kind+'_key']!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(r[d.kind+'_key'])) return unknown;
    result.resource=Object.fromEntries(['upload_id','app_id','brand','kind','sha256','size','name','file_type',d.kind+'_key'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
  }
  for (const k of ['request_phase','error_code']) if (typeof raw[k]==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(raw[k])) result[k]=raw[k];
  for (const k of ['code','http_status','elapsed_ms']) if (Number.isSafeInteger(raw[k])) result[k]=raw[k];
  return result;
}
export function createAttachments({locked,read,save}) {
  const get = (data,id) => { const row=data.uploads?.find(u=>u.id===id);if(!row)fail('Unknown attachment upload');return row; };
  const connection = (data,row) => { const c=data.connections.find(c=>c.id===row.connector&&c.binding===row.binding&&c.enabled&&c.capabilities.upload);if(!c)fail('Attachment connector binding is unavailable');return c; };
  async function run(args) {
    requireText(args.id,'upload ID');
    if(args.command==='attachment-status') return locked(()=>structuredClone(get(read(),args.id)));
    if(args.command==='attachment-reconcile') {
      const {u,c}=await locked(()=>{const d=read(),u=get(d,args.id);return {u:structuredClone(u),c:connection(d,u)};});
      if(u.state==='uploaded')return u;
      const {adapter}=await bounded(()=>loadConnector(c),15000);
      let raw;try{raw=await bounded(signal=>adapter.uploadStatus({account_id:u.account,idempotency_key:u.key},{signal}));}catch{raw=null;}
      const receipt=checked(raw,u);
      return locked(()=>{const d=read(),current=get(d,u.id);connection(d,current);
        // A read racing with an upload must never regress a stored successful receipt.
        if(current.state!=='uploaded'){current.receipt=receipt;current.state=receipt.status;save(d);}return current;});
    }
    requireText(args.authorization_ref,'attachment authorization');
    if(!['image','file'].includes(args.kind))fail('Choose image or file (PDF)');
    const spec={connector:args.connector,filePath:requireText(args.path,'attachment path',2048),allowedRoot:requireText(args.allowed_root,'authorized root',2048),kind:args.kind,authorization_ref:args.authorization_ref};
    const prior=await locked(()=>read().uploads?.find(u=>u.id===args.id));
    if(prior){if(prior.input_digest!==digest(spec))fail('Upload ID conflicts with prior input');return prior;}
    const c=await locked(()=>{const c=read().connections.find(c=>c.id===args.connector&&c.enabled&&c.capabilities.upload);if(!c)fail('Connector does not support authorized uploads');return c;});
    const {adapter}=await bounded(()=>loadConnector(c),15000);
    const descriptor=await bounded(signal=>adapter.inspectUpload({filePath:spec.filePath,allowedRoot:spec.allowedRoot,kind:spec.kind},{signal}),15000);
    if (!descriptor || Object.keys(descriptor).some(k=>!['filePath','allowedRoot','kind','name','size','sha256','file_type'].includes(k)) || descriptor.filePath!==spec.filePath || descriptor.allowedRoot!==spec.allowedRoot || descriptor.kind!==spec.kind || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.size) || descriptor.size<1 || descriptor.size>(args.kind==='image'?10:30)*1024*1024) fail('Invalid inspected attachment');
    requireText(descriptor.name,'attachment name',255);
    if (descriptor.kind==='file' && descriptor.file_type!=='pdf') fail('Only PDF file attachments are supported');
    const u={id:args.id,connector:c.id,binding:c.binding,account:c.settings.account_id,brand:c.settings.brand,key:'upload-'+digest([args.id,c.binding]).slice(0,40),descriptor,input_digest:digest(spec),authorization_ref:args.authorization_ref,state:'uploading',receipt:null,created_at:new Date().toISOString()};
    requireText(u.account,'attachment account');if(!['feishu','lark'].includes(u.brand))fail('Attachment platform is required');
    const claimed=await locked(()=>{const d=read();connection(d,u);const prior=d.uploads?.find(p=>p.id===u.id);if(prior){if(prior.input_digest!==u.input_digest)fail('Upload ID conflict');return false;}(d.uploads??=[]).push(u);save(d);return true;});
    if(!claimed)return locked(()=>get(read(),u.id));
    let raw;try{raw=await bounded(signal=>adapter.upload({account_id:u.account,descriptor:u.descriptor,idempotency_key:u.key},{signal}));}catch{raw=null;}
    const receipt=checked(raw,u);
    return locked(()=>{const d=read(),current=get(d,u.id);if(current.state!=='uploaded'){current.receipt=receipt;current.state=receipt.status;save(d);}return current;});
  }
  return {run};
}
