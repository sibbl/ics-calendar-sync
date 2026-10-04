import {createHash} from 'node:crypto';
import type {Source,Plan} from '../shared/contracts.js';
import {parseCalendar} from './calendar.js';
import {stableJSON,MAPPING_VERSION} from './event-fingerprint.js';
// Ephemeral parse optimization only. Every invocation still reads the complete
// source and compares owned target state; this cache never authorizes deletions.
export class SourcePlanCache {
 private entries=new Map<string,{plan:Plan;bytes:number}>();private bytes=0;
 clear(){this.entries.clear();this.bytes=0;}
 parse(data:Uint8Array,source:Source,target?:string){
  const key=createHash('sha256').update(data).update(stableJSON([MAPPING_VERSION,source.id,target??'',source.rules])).digest('hex');
  const cached=this.entries.get(key);if(cached){this.entries.delete(key);this.entries.set(key,cached);return structuredClone(cached.plan);}
  const plan=parseCalendar(data,source.id,source.rules,target),bytes=Buffer.byteLength(JSON.stringify(plan));
  if(bytes<=8*1024*1024){while(this.entries.size>=128||this.bytes+bytes>8*1024*1024){const oldest=this.entries.keys().next().value!;this.bytes-=this.entries.get(oldest)!.bytes;this.entries.delete(oldest);}this.entries.set(key,{plan:structuredClone(plan),bytes});this.bytes+=bytes;}
  return plan;
 }
}
