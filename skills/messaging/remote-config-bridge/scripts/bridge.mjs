#!/usr/bin/env node
import {Store,boundedRead,atomic,enqueue,exportBatch,processBatch,importReceipts,getJob,fileHash} from './core.mjs';
const [command,...rest]=process.argv.slice(2),options={};
try{for(let i=0;i<rest.length;i+=2){if(!/^--[a-z-]+$/.test(rest[i])||!rest[i+1]||options[rest[i]])throw Error('Invalid arguments');options[rest[i]]=rest[i+1];}
 const allowed={ 'init-cloud':['store','binding','thread-id'],'init-local':['store','binding'],enqueue:['store','input'],export:['store','output','limit'],process:['store','input','output'],import:['store','input'],show:['store','id'],status:['store'],hash:['file']};
 if(!allowed[command]||Object.keys(options).some(k=>!allowed[command].includes(k.slice(2))))throw Error('Use init-cloud, init-local, enqueue, export, process, import, show, status or hash');
 const need=k=>{if(!options['--'+k])throw Error('Missing --'+k);return options['--'+k];};let result;
 if(command==='hash')result={sha256:fileHash(need('file'))};
 else{const s=new Store(need('store'));if(command.startsWith('init-'))result=await s.init(command.slice(5),boundedRead(need('binding')),command==='init-cloud'?need('thread-id'):null);
 else if(command==='enqueue')result=await enqueue(s,boundedRead(need('input')));
 else if(command==='export'){result=await exportBatch(s,Number(options['--limit']??20));atomic(need('output'),result);result={jobs:result.jobs.length,output:options['--output']};}
 else if(command==='process'){result=await processBatch(s,boundedRead(need('input')));atomic(need('output'),result);result={receipts:result.receipts.length,output:options['--output']};}
 else if(command==='import')result=await importReceipts(s,boundedRead(need('input')));
 else if(command==='show')result=await getJob(s,need('id'));
 else result=await s.lock(()=>{const d=s.read();return {role:d.role,thread_id:d.thread_id,jobs:d.jobs.map(e=>({id:e.job.id,operation:e.job.operation,state:e.state,status:e.receipt?.result.status??null}))};});}
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(e){process.stderr.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=2;}
