import {stampFingerprint,stableJSON} from './event-fingerprint.js';
import {DateTime} from 'luxon';
import type {RemoteEvent} from './google.js';
import type {EventTime,Plan,Source} from '../shared/contracts.js';
import {opaque,parseCalendar} from './calendar.js';
import {AppError,MAX_BYTES} from './errors.js';
export interface SourceEvent {id:string;etag?:string;status?:string;summary?:string;location?:string;attendeesOmitted?:boolean;transparency?:string;start?:EventTime;end?:EventTime;recurrence?:string[];recurringEventId?:string;originalStartTime?:EventTime;attendees?:{responseStatus?:string}[];extendedProperties?:{private?:Record<string,string>}}
export interface SourcePage {items:SourceEvent[];nextPageToken?:string;nextSyncToken?:string}
export class ExpiredCursor extends AppError {constructor(){super('Google-Sync-Cursor abgelaufen.');}}
export interface GoogleSourcePort {readEvents(calendarId:string,params:Record<string,string>):Promise<SourcePage>;getSourceEvent?(calendarId:string,id:string):Promise<SourceEvent|null>}
// Notifications may call invalidate/wake later; no watch channel or public endpoint is registered.
export class GoogleSourceReader {
 private snapshots=new Map<string,{token:string;events:Map<string,SourceEvent>;fetched:number}>();
 invalidate(calendarId?:string){if(calendarId)this.snapshots.delete(calendarId);else this.snapshots.clear();}
 async snapshot(calendarId:string,port:GoogleSourcePort):Promise<AuthoritativeGoogleSnapshot>{
  const events=await this.read(calendarId,port),unresolvedParents:string[]=[],byId=new Map(events.map(e=>[e.id,e]));
  const parents=new Set(events.filter(e=>e.recurringEventId&&!byId.has(e.recurringEventId)).map(e=>e.recurringEventId!));
  for(const id of parents){
   if(!port.getSourceEvent)throw new AppError('Google-Serienmaster fehlt im Abruf; Elternauflösung nicht verfügbar.');
   const parent=await port.getSourceEvent(calendarId,id);
   if(!parent){if(events.some(e=>e.recurringEventId===id&&e.status!=='cancelled'))unresolvedParents.push(id);continue;}
   if(parent.id!==id||parent.recurringEventId||parent.status!=='cancelled'&&!parent.recurrence?.length)throw new AppError('Google-Serienmaster ungültig; Abgleich gestoppt.');byId.set(id,parent);
  }
  const complete=[...byId.values()];if(complete.length>10000||Buffer.byteLength(JSON.stringify(complete))>MAX_BYTES)throw new AppError('Google-Quelle nach Serienauflösung zu groß.');
  // Hydrated parents survive later exception-only deltas. Rebuilds/410 resolve them again.
  const cached=this.snapshots.get(calendarId);if(cached)cached.events=byId;
  return {events:complete,complete:true,scope:'all-events',unresolvedParents,revision:opaque('google-revision-v1',stableJSON([...complete].sort((a,b)=>a.id.localeCompare(b.id)))),fetched:cached?.fetched??complete.length};
 }
 async read(calendarId:string,port:GoogleSourcePort):Promise<SourceEvent[]> {
  const previous=this.snapshots.get(calendarId);
  const fetchSnapshot=async(incremental:boolean)=>{
   const events=incremental?new Map(previous!.events):new Map<string,SourceEvent>();const seen=new Set<string>(),seenEvents=new Set<string>();let pageToken:string|undefined;let fetched=0;
   for(let page=0;page<100;page++){
    const data=await port.readEvents(calendarId,{singleEvents:'false',showDeleted:'true',maxResults:'2500',...(incremental?{syncToken:previous!.token}:{}),...(pageToken?{pageToken}:{})});
    if(!Array.isArray(data.items))throw new AppError('Google-Quellseite ungültig.');fetched+=data.items.length;
    for(const event of data.items){if(!event||typeof event.id!=='string'||!event.id||seenEvents.has(event.id))throw new AppError('Google-Quelltermin ungültig.');seenEvents.add(event.id);events.set(event.id,event);}
    if(events.size>10000||Buffer.byteLength(JSON.stringify([...events.values()]))>MAX_BYTES)throw new AppError('Google-Quelle zu groß; vollständig übersprungen.');
    if(data.nextPageToken!==undefined&&typeof data.nextPageToken!=='string')throw new AppError('Google-Quellpaginierung ungültig.');
    if(data.nextPageToken){if(typeof data.nextPageToken!=='string'||seen.has(data.nextPageToken))throw new AppError('Google-Quellpaginierung ungültig.');seen.add(data.nextPageToken);pageToken=data.nextPageToken;continue;}
    if(typeof data.nextSyncToken!=='string'||!data.nextSyncToken)throw new AppError('Google-Quellcursor fehlt; vollständig übersprungen.');
    this.snapshots.set(calendarId,{token:data.nextSyncToken,events,fetched});return [...events.values()];
   }throw new AppError('Zu viele Google-Quellseiten.');
  };
  try{return await fetchSnapshot(!!previous);}catch(error){if(error instanceof ExpiredCursor&&previous){this.invalidate(calendarId);return fetchSnapshot(false);}throw error;}
 }
}
function timeLine(name:string,time:EventTime|undefined){
 if(!time)throw new AppError('Google-Zeitfeld fehlt.');
 if(time.date){if(!/^\d{4}-\d{2}-\d{2}$/.test(time.date))throw new AppError('Google-Datum ungültig.');return name+';VALUE=DATE:'+time.date.replaceAll('-','');}
 const zone=time.timeZone||'UTC',dt=DateTime.fromISO(time.dateTime!,{zone});if(!dt.isValid||/[\r\n:;]/.test(zone))throw new AppError('Google-Zeit ungültig.');
 return name+(zone==='UTC'?':':';TZID='+zone+':')+dt.toFormat("yyyyMMdd'T'HHmmss")+(zone==='UTC'?'Z':'');
}
const escape=(s:string)=>s.replaceAll('\\','\\\\').replaceAll('\r','').replaceAll('\n','\\n').replaceAll(';','\\;').replaceAll(',','\\,');
export function googleSourcePlan(events:SourceEvent[],source:Source,target?:string):Plan {
 const managed=new Set(events.filter(e=>e.extendedProperties?.private?.icsSync==='v1').map(e=>e.id));
 const selected=events.filter(e=>!managed.has(e.id)&&!managed.has(e.recurringEventId??''));
 const cancelledMasters=new Set(selected.filter(e=>!e.recurringEventId&&e.status==='cancelled').map(e=>e.id));
 const activeMasters=new Set(selected.filter(e=>!e.recurringEventId&&e.status!=='cancelled').map(e=>e.id));
 const uid=(id:string)=>opaque('google',source.sourceCalendarId!,id);
 const cancelled:Plan['items']=[];const components:string[]=[];
 for(const event of selected){
  if(event.recurringEventId&&cancelledMasters.has(event.recurringEventId))continue;
  if(event.recurringEventId&&!activeMasters.has(event.recurringEventId)){if(event.status==='cancelled')continue;throw new AppError('Verwaiste Google-Serienausnahme; vollständig übersprungen.');}
  if(!event.recurringEventId&&event.status==='cancelled'){cancelled.push({key:target?opaque(source.id,target,uid(event.id)):opaque(source.id,uid(event.id)),cancel:true});continue;}
  const lines=['BEGIN:VEVENT','UID:'+uid(event.recurringEventId??event.id)];
  if(event.recurringEventId)lines.push(timeLine('RECURRENCE-ID',event.originalStartTime));
  if(event.status==='cancelled')lines.push('STATUS:CANCELLED');else{
   lines.push(timeLine('DTSTART',event.start),timeLine('DTEND',event.end),'SUMMARY:'+escape(event.summary??''),'LOCATION:'+escape(event.location??''),'TRANSP:'+(event.transparency==='transparent'?'TRANSPARENT':'OPAQUE'));
   for(const rule of event.recurrence??[]){if(!/^(RRULE:|RDATE[;:]|EXDATE[;:])/.test(rule)||/[\r\n]/.test(rule))throw new AppError('Google-Wiederholung ungültig.');lines.push(rule);}
   if(event.attendeesOmitted||!event.attendees?.length)lines.push('X-ICS-SYNC-ATTENDANCE:UNKNOWN');for(const attendee of event.attendees??[]){const status=({accepted:'ACCEPTED',declined:'DECLINED',tentative:'TENTATIVE',needsAction:'NEEDS-ACTION'} as Record<string,string>)[attendee.responseStatus??''];lines.push('ATTENDEE'+(status?';PARTSTAT='+status:'')+':urn:anonymous');}
  }
  lines.push('END:VEVENT');components.push(lines.join('\r\n'));
 }
 const plan=parseCalendar(new TextEncoder().encode(['BEGIN:VCALENDAR','VERSION:2.0',...components,'END:VCALENDAR',''].join('\r\n')),source.id,source.rules,target);
 for(const item of plan.items)if(item.event){item.event.extendedProperties.private.origin=googleOrigin(source);stampFingerprint(item.event,source.rules);}
 plan.items.push(...cancelled);plan.stats.explicitCancellations+=cancelled.length;plan.warnings.push('Google-Polling: vollständiger Quellstand; fehlende exakt zugeordnete Zielmaster werden abgeglichen. Keine Löschungen aus unvollständigen Abrufen.');return plan;
}
export function validateSourceGraph(sources:Source[],defaultTarget:string){
 const edges=new Map<string,string[]>();for(const source of sources){if(source.kind!=='google')continue;const from=source.sourceCalendarId!,to=source.calendarId||defaultTarget;if(!to)continue;edges.set(from,[...(edges.get(from)??[]),to]);}
 const visiting=new Set<string>(),done=new Set<string>();function visit(node:string){if(visiting.has(node))throw new AppError('Google-Quelle/Ziel erzeugt eine Kopierschleife.');if(done.has(node))return;visiting.add(node);for(const next of edges.get(node)??[])visit(next);visiting.delete(node);done.add(node);}for(const node of edges.keys())visit(node);
}

// This proof is only produced by GoogleSourceReader after a complete, unbounded read.
// An incremental snapshot inherits completeness from its completed full baseline.
export interface AuthoritativeGoogleSnapshot {events:SourceEvent[];complete:true;scope:'all-events';unresolvedParents?:string[];revision?:string;fetched?:number}
export function googleOrigin(source:Source){return opaque('google-origin-v1',source.sourceCalendarId!);}
export function reconcileGoogleMasters(plan:Plan,snapshot:AuthoritativeGoogleSnapshot,source:Source,target:string,destination:RemoteEvent[]):Plan {
 if(snapshot.complete!==true||snapshot.scope!=='all-events'||source.kind!=='google'||!target)throw new AppError('Google-Reconciliation benötigt einen vollständigen unbegrenzten Quellstand.');
 const expected=new Set([...plan.items.filter(i=>!i.parent).map(i=>i.key),...(plan.protectedMasterKeys??[])]);for(const id of snapshot.unresolvedParents??[])expected.add(opaque(source.id,target,opaque('google',source.sourceCalendarId!,id)));const origin=googleOrigin(source);
 const result:Plan=structuredClone(plan);let count=0;
 for(const event of destination){const markers=event.extendedProperties?.private;
  // Never infer an instance deletion. Its parent recurrence and explicit source exceptions govern it.
  if(event.recurringEventId||event.status==='cancelled'||markers?.icsSync!=='v1'||markers.source!==source.id||markers.calendar!==target||markers.origin!==origin||markers.key!==event.id||!/^[0-9a-v]{52}$/.test(event.id))continue;
  if(!expected.has(event.id)){result.items.push({key:event.id,cancel:true,reconcileOrigin:origin});expected.add(event.id);count++;}
 }
 result.stats.reconciledCancellations=count;
 result.warnings.push('Reconciliation: '+count+' fehlende exakt zugeordnete Zielmaster. Serieninstanzen nur anhand expliziter Quellausnahmen.');return result;
}

export function safeGoogleSourcePlan(snapshot:AuthoritativeGoogleSnapshot,source:Source,target?:string):Plan {
 // Validate global rules before isolating source data problems.
 const result=googleSourcePlan([],source,target),unresolved=new Set(snapshot.unresolvedParents??[]),groups=new Map<string,SourceEvent[]>();
 result.protectedMasterKeys=[];result.stats.quarantinedSeries=unresolved.size;result.stats.quarantinedGroups=0;
 for(const event of snapshot.events){if(unresolved.has(event.recurringEventId??''))continue;const id=event.recurringEventId??event.id;groups.set(id,[...(groups.get(id)??[]),event]);}
 const warnings=new Set(result.warnings);
 for(const [id,group] of groups){try{
   const plan=googleSourcePlan(group,source,target);result.items.push(...plan.items);result.stats.uids=(result.stats.uids??0)+(plan.stats.uids??0);result.stats.upserts+=plan.stats.upserts;result.stats.explicitCancellations+=plan.stats.explicitCancellations;result.stats.components=(result.stats.components??0)+(plan.stats.components??0);result.stats.exceptions=(result.stats.exceptions??0)+(plan.stats.exceptions??0);for(const warning of plan.warnings)warnings.add(warning);
  }catch(error){if(!(error instanceof AppError))throw error;result.stats.quarantinedGroups!++;result.protectedMasterKeys.push(target?opaque(source.id,target,opaque('google',source.sourceCalendarId!,id)):opaque(source.id,opaque('google',source.sourceCalendarId!,id)));}
 }
 if(unresolved.size)warnings.add(unresolved.size+' Google-Serienmaster fehlen auch beim direkten Abruf. Ihre Ausnahmen werden separat zurückgestellt; bestehende zugehörige Zielserien bleiben geschützt. Alle übrigen Termine werden verarbeitet.');
 if(result.stats.quarantinedGroups)warnings.add(result.stats.quarantinedGroups+' Quellgruppen mit nicht abbildbaren Daten separat zurückgestellt; bestehende Kopien geschützt. Es werden keine Zeiten oder Wiederholungen erfunden.');
 result.warnings=[...warnings];return result;
}
