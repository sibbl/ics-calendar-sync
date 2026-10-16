import {DateTime} from 'luxon';
import {opaque} from './calendar.js';
import {clipScope} from './clip-window.js';
import {validatedWindow,allowsSnapshotCancellation} from './snapshot-preview.js';
import {stampFingerprint} from './event-fingerprint.js';
import {sameRecurrence} from './series-structure.js';
import {windowOccurrences,timed,windowFail} from './window-recurrence.js';
import type {Item,Plan,Source,TargetEvent} from '../shared/contracts.js';
import type {RemoteEvent} from './google.js';
const line=(name:string,values:number[])=>name+':'+[...new Set(values)].sort((a,b)=>a-b).map(ms=>DateTime.fromMillis(ms,{zone:'UTC'}).toFormat("yyyyMMdd'T'HHmmss'Z'")).join(',');
const owned=(e:RemoteEvent,s:Source)=>e.extendedProperties?.private?.icsSync==='v1'&&e.extendedProperties.private.source===s.id&&e.extendedProperties.private.calendar===s.calendarId&&!e.extendedProperties.private.origin&&e.extendedProperties.private.key===e.id;
export function reconcileWindowSeries(plan:Plan,source:Source,target:RemoteEvent[]):Plan {
 const scope=clipScope(plan,source),w=validatedWindow(scope);if(!w||scope.authority!=='window'||w.endMillis-w.startMillis>370*86400000)return windowFail();
 const inside=(a:number,b:number)=>a>=w.startMillis&&b>a&&(scope.boundary==='protect-boundary'?b<w.endMillis:b<=w.endMillis);
 const contained=(e:{start?:TargetEvent['start'];end?:TargetEvent['end']})=>allowsSnapshotCancellation({id:'scope',start:e.start,end:e.end},scope);
 const result=structuredClone(plan),output:Item[]=[],roots=new Map(plan.items.filter(i=>!i.parent).map(i=>[i.key,i]));let series=0,expansionBudget=200000;
 for(const old of target)if(old.recurrence?.length&&owned(old,source)&&old.status!=='cancelled'&&!roots.has(old.id))roots.set(old.id,{key:old.id,cancel:true});
 for(const input of roots.values()){
  const old=target.find(e=>e.id===input.key&&!e.recurringEventId),incoming=input.cancel?undefined:input.event;
  if(!incoming?.recurrence?.length&&!old?.recurrence?.length){if(incoming&&contained(incoming)||input.cancel&&old&&contained(old))output.push(structuredClone(input));continue;}
  if(old&&(!owned(old,source)||!old.etag||old.status==='cancelled'||!old.recurrence?.length))return windowFail();
  if(incoming&&!incoming.recurrence?.length)return windowFail();
  const oldDuration=old?timed(old.end).toMillis()-timed(old.start).toMillis():undefined;
  if(oldDuration!==undefined&&oldDuration<=0)return windowFail();
  const previous=old?windowOccurrences(old,w.endMillis):undefined;
  const next=incoming?windowOccurrences(incoming,w.endMillis):undefined;expansionBudget-=(previous?.all.length??0)+(next?.all.length??0);if(expansionBudget<0)return windowFail();
  const duration=incoming?timed(incoming.end).toMillis()-timed(incoming.start).toMillis():0;if(incoming&&duration<=0)return windowFail();
  const children=plan.items.filter(i=>i.parent===input.key),desired=new Map<number,TargetEvent>();
  if(incoming&&next){for(const ms of next.effective){if(!inside(ms,ms+duration)){if(ms<w.endMillis&&ms+duration>w.startMillis)return windowFail();continue;}if(previous?.all.includes(ms)&&!inside(ms,ms+oldDuration!))return windowFail();const start=DateTime.fromMillis(ms,{zone:incoming.start.timeZone});desired.set(ms,{...structuredClone(incoming),start:{dateTime:start.toISO()!,timeZone:start.zoneName!},end:{dateTime:start.plus({milliseconds:duration}).toISO()!,timeZone:start.zoneName!},recurrence:undefined});}
   for(const child of children){const ms=timed(child.original).toMillis();if(!next.all.includes(ms))return windowFail();if(child.cancel){desired.delete(ms);continue;}if(!child.event)return windowFail();if(!inside(ms,ms+duration)||!contained(child.event)){if(inside(ms,ms+duration)||contained(child.event))return windowFail();continue;}desired.set(ms,structuredClone(child.event));}
  }
  if(!old&&!desired.size)continue;
  if(desired.size>2000||output.length+desired.size+1>10000)return windowFail();
  const originalOldInside=previous?.all.filter(ms=>inside(ms,ms+oldDuration!))??[];
  if(old)for(const current of target.filter(e=>e.recurringEventId===old.id&&e.status!=='cancelled')){
   const ms=timed(current.originalStartTime).toMillis(),originalInside=inside(ms,ms+oldDuration!);
   if(!originalInside&&!contained(current))continue;
   if(!originalInside||!contained(current))return windowFail();
   const markers=current.extendedProperties?.private;
   if(!markers||markers.icsSync!=='v1'||markers.source!==source.id||markers.calendar!==source.calendarId||markers.origin||!current.etag)return windowFail();
   if(!desired.has(ms)&&(!markers.key||markers.key===old.id))return windowFail();
   if(!desired.has(ms)&&markers.key)output.push({key:markers.key,parent:old.id,original:current.originalStartTime,cancel:true,approvedCancelEtag:current.etag,approvedCancelScope:scope});
  }
  const first=[...desired.keys()].sort((a,b)=>a-b)[0];
  let master:TargetEvent;
  if(old){const dates=previous!.dates;const recurrence=old.recurrence!.filter(l=>l.startsWith('RRULE:'));
   const rdates=[...dates.RDATE,...[...desired.keys()].filter(ms=>!previous!.all.includes(ms))];
   const excluded=[...dates.EXDATE.filter(ms=>!inside(ms,ms+oldDuration!)),...originalOldInside.filter(ms=>!desired.has(ms))];
   if(rdates.length)recurrence.push(line('RDATE',rdates));if(excluded.length)recurrence.push(line('EXDATE',excluded));
   // Serialization-only differences must not provoke a recurring-master rewrite.
   const unchanged=recurrence.length===old.recurrence!.length&&sameRecurrence(recurrence,old.recurrence!);
   master={summary:old.summary??'',...(old.location?{location:old.location}:{}),start:old.start!,end:old.end!,status:'confirmed',transparency:'opaque',visibility:'private',reminders:{useDefault:false},extendedProperties:{private:{icsSync:'v1',source:source.id,key:input.key,calendar:source.calendarId}},recurrence:unchanged?old.recurrence:recurrence};
  }else{const start=DateTime.fromMillis(first!,{zone:incoming!.start.timeZone});master={...structuredClone(incoming!),start:{dateTime:start.toISO()!,timeZone:start.zoneName!},end:{dateTime:start.plus({milliseconds:duration}).toISO()!,timeZone:start.zoneName!},recurrence:[line('RDATE',[...desired.keys()])]};}
  master=stampFingerprint({...master,extendedProperties:{private:{...master.extendedProperties.private,key:input.key}}},source.rules);const root:Item={key:input.key,cancel:false,event:master};
  if(old&&!sameRecurrence(old.recurrence!,master.recurrence??[])){root.clipSeriesEtag=old.etag;root.windowSeriesInput=structuredClone([input,...children]);}
  output.push(root);
  for(const [ms,event] of desired){const child=children.find(i=>i.original&&timed(i.original).toMillis()===ms),key=child?.key??opaque('window-instance-v1',input.key,String(ms));const original=child?.original??{dateTime:DateTime.fromMillis(ms,{zone:'UTC'}).toISO()!,timeZone:'UTC'};
   const body=stampFingerprint({...event,recurrence:undefined,extendedProperties:{private:{...event.extendedProperties.private,key}}},source.rules);output.push({key,parent:input.key,original,cancel:false,event:body});
  }
  series++;
 }
 if(output.length>10000)return windowFail();result.items=output;result.stats.upserts=output.filter(i=>!i.cancel).length;result.stats.explicitCancellations=output.filter(i=>i.cancel).length;result.stats.normalizedClipSeries=series;
 result.warnings.push('Fensterabgleich: Serienmaster bleiben zeitlich erhalten. Wiederholungen und Instanzzeiten werden nur im bestätigten Fenster ersetzt; Grenzkonflikte stoppen.');return result;
}
