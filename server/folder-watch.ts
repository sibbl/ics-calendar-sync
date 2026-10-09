import {watch as nativeWatch} from 'node:fs';
import type {Source} from '../shared/contracts.js';
import {RevisionError} from './errors.js';
import {folderFingerprint} from './sources.js';
export interface WatchStatus {mode:'watching'|'polling'|'settling';error?:string}
export interface WatchHandle {close():void}
export interface WatchAdapters {fingerprint(source:Source,root:string):Promise<{signature:string;path:string;identity:string}>;watch(path:string,change:()=>void,error:()=>void):WatchHandle}
const defaults:WatchAdapters={fingerprint:(source,root)=>folderFingerprint(root,source.location),watch:(path,change,error)=>{const handle=nativeWatch(path,{persistent:false,recursive:false},(event,name)=>{if(event==='rename'||!name||String(name).toLowerCase().endsWith('.ics'))change();});handle.on('error',error);return handle;}};
interface Entry {source:Source;config:string;handle?:WatchHandle;path?:string;identity?:string;dirty:boolean;nextPoll:number;retryAt:number;candidate?:string;since:number;committed?:string;running:boolean;retryRun:number;failures:number}
export class FolderWatchManager {
 readonly statuses:Record<string,WatchStatus>={};private entries=new Map<string,Entry>();private flight?:Promise<void>;private closed=false;
 constructor(private root:string,private trigger:(id:string)=>Promise<unknown>,private adapters:WatchAdapters=defaults,private options={settleMs:1000,pollMs:5000,reconnectMs:30000}){}
 async tick(sources:Source[],now=Date.now()){
  if(this.closed)return;if(this.flight)return this.flight;
  this.flight=this.scan(sources,now);try{await this.flight;}finally{this.flight=undefined;}
 }
 private async scan(sources:Source[],now:number){
  const eligible=sources.filter(s=>s.enabled&&s.kind==='folder'&&s.watch),ids=new Set(eligible.map(s=>s.id));
  for(const [id,entry] of this.entries)if(!ids.has(id)){entry.handle?.close();this.entries.delete(id);delete this.statuses[id];}
  for(const source of eligible){if(this.closed)return;const config=JSON.stringify([source,this.root]);let entry=this.entries.get(source.id);
   if(entry&&entry.config!==config){entry.handle?.close();this.entries.delete(source.id);entry=undefined;}
   if(!entry){entry={source,config,dirty:true,nextPoll:0,retryAt:0,since:now,running:false,retryRun:0,failures:0};this.entries.set(source.id,entry);}entry.source=source;
   // Native events wake scans; polling also covers dropped events and network mounts.
   if(!entry.dirty&&now<entry.nextPoll&&!(entry.candidate!==entry.committed&&now-entry.since>=this.options.settleMs&&now>=entry.retryRun))continue;
   entry.dirty=false;entry.nextPoll=now+this.options.pollMs;
   try{
    const current=await this.adapters.fingerprint(source,this.root);if(this.closed)return;
    if(entry.path!==current.path||entry.identity!==current.identity){entry.handle?.close();entry.handle=undefined;entry.path=current.path;entry.identity=current.identity;entry.retryAt=0;}
    if(!entry.handle&&now>=entry.retryAt){entry.retryAt=now+this.options.reconnectMs;const active=entry;try{entry.handle=this.adapters.watch(current.path,()=>{active.dirty=true;},()=>{active.handle?.close();active.handle=undefined;active.dirty=true;this.statuses[source.id]={mode:'polling',error:'Dateibeobachtung nicht verfügbar; Polling aktiv.'};});}catch{entry.handle=undefined;}}
    if(entry.candidate!==current.signature){entry.candidate=current.signature;entry.since=now;entry.retryRun=0;entry.failures=0;}
    const pending=entry.candidate!==entry.committed;
    this.statuses[source.id]={mode:pending&&now-entry.since<this.options.settleMs?'settling':entry.handle?'watching':'polling',...!entry.handle?{error:'Dateibeobachtung nicht verfügbar; Polling aktiv.'}:{}};
    if(pending&&!entry.running&&now-entry.since>=this.options.settleMs&&now>=entry.retryRun){
     entry.running=true;const active=entry,signature=current.signature;
     void this.trigger(source.id).then(()=>{if(this.entries.get(source.id)===active){active.committed=signature;active.failures=0;}},(error)=>{if(active.candidate!==signature)return;active.failures++;active.retryRun=error instanceof RevisionError?Infinity:now+Math.min(Math.max(this.options.pollMs,source.intervalSeconds*1000),this.options.pollMs*2**Math.min(active.failures-1,16));}).finally(()=>{active.running=false;});
    }
   }catch{entry.handle?.close();entry.handle=undefined;entry.retryAt=now+this.options.reconnectMs;entry.nextPoll=now+this.options.pollMs;this.statuses[source.id]={mode:'polling',error:'Quellordner nicht vollständig lesbar; erneuter Versuch per Polling.'};}
  }
 }
 reset(id:string){const entry=this.entries.get(id);if(entry){entry.committed=undefined;entry.retryRun=0;entry.failures=0;entry.dirty=true;}}
 async close(){this.closed=true;for(const entry of this.entries.values())entry.handle?.close();this.entries.clear();for(const key of Object.keys(this.statuses))delete this.statuses[key];await this.flight;}
}
