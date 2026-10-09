import {staleExceptionRestore} from './stale-exceptions.js';
import {DateTime} from 'luxon';
import {AppError} from './errors.js';
import {sameManagedEvent} from './event-equivalence.js';
import type {RemoteEvent} from './google.js';
import type {Plan,Source,EventTime} from '../shared/contracts.js';
export interface SnapshotScope {authority:'unknown'|'full'|'window';basis?:'clip';boundary?:'exclusive'|'protect-boundary';window?:{start:string;end:string;timezone:string}}
export interface SnapshotPreview {proposedRestores:import('../shared/contracts.js').Item[];restoreEtags:Record<string,string>;clipWindow?:import('./clip-window.js').ClipWindow;token?:string;removalEtags:Record<string,string>;removalTimes:{key:string;start?:EventTime;end?:EventTime}[];authority:SnapshotScope['authority'];start?:string;end?:string;timezone?:string;added:number;changed:number;unchanged:number;explicitCancellations:number;proposedRemovals:string[];protectedAbsent:number;requiresRemovalApproval:true;warnings:string[]}
export function validatedWindow(scope:SnapshotScope){
 if(scope.authority!=='window'){if(scope.window)throw new AppError('Fenster nur bei ausdrücklich begrenztem Snapshot.');return;}
 const w=scope.window;if(!w||!(scope.basis==='clip'?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(w.start)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(w.end):/^\d{4}-\d{2}-\d{2}$/.test(w.start)&&/^\d{4}-\d{2}-\d{2}$/.test(w.end)))throw new AppError('Snapshot benötigt bestätigten Beginn, exklusives Ende und Zeitzone.');
 try{new Intl.DateTimeFormat('en',{timeZone:w.timezone});}catch{throw new AppError('Snapshot-Zeitzone ungültig.');}
 const start=DateTime.fromISO(w.start,{zone:w.timezone}),end=DateTime.fromISO(w.end,{zone:w.timezone});
 if(!start.isValid||!end.isValid||scope.basis!=='clip'&&(start.toISODate()!==w.start||end.toISODate()!==w.end)||end.toMillis()<=start.toMillis())throw new AppError('Snapshot-Fenster ungültig.');
 return {startMillis:start.toMillis(),endMillis:end.toMillis(),...w};
}
function instant(value:EventTime|undefined,timezone:string){if(!value)return NaN;const date=value.date?DateTime.fromISO(value.date,{zone:timezone}):DateTime.fromISO(value.dateTime!,{setZone:true});return date.isValid?date.toMillis():NaN;}
export function allowsSnapshotCancellation(current:RemoteEvent,scope:SnapshotScope){
 if(scope.authority==='full')return !current.recurringEventId;
 const window=validatedWindow(scope);if(!window||current.recurringEventId||current.recurrence?.length)return false;
 const start=instant(current.start,window.timezone),end=instant(current.end,window.timezone);
 return Number.isFinite(start)&&Number.isFinite(end)&&start<end&&start>=window.startMillis&&(scope.boundary==='protect-boundary'?end<window.endMillis:end<=window.endMillis);
}
// Pure preview: no filesystem operations, API calls, mutation or inferred authority.
export function previewSnapshot(plan:Plan,source:Source,target:RemoteEvent[],scope:SnapshotScope):SnapshotPreview {
 const window=validatedWindow(scope),marked=target.filter(e=>{const p=e.extendedProperties?.private;return p?.icsSync==='v1'&&p.source===source.id&&!!p.key&&(!source.calendarId||p.calendar===source.calendarId)&&!p.origin;}),masterIds=new Set(marked.filter(e=>!e.recurringEventId&&e.extendedProperties!.private!.key===e.id).map(e=>e.id)),owned=marked.filter(e=>e.recurringEventId?masterIds.has(e.recurringEventId):masterIds.has(e.id));
 const known=new Map(owned.map(e=>[e.recurringEventId?e.extendedProperties!.private!.key!:e.id,e])),present=new Set(plan.items.map(i=>i.key));
 const result:SnapshotPreview={proposedRestores:[],restoreEtags:{},authority:scope.authority,...window?{start:window.start,end:window.end,timezone:window.timezone}:{},added:0,changed:0,unchanged:0,explicitCancellations:0,proposedRemovals:[],protectedAbsent:0,requiresRemovalApproval:true,removalEtags:{},removalTimes:[],warnings:[]};
 if(scope.window){result.start=scope.window.start;result.end=scope.window.end;}
 for(const item of plan.items){if(item.cancel){result.explicitCancellations++;continue;}const current=known.get(item.key);if(!current)result.added++;else if(sameManagedEvent(current,item.event!))result.unchanged++;else result.changed++;}
 for(const current of owned){if(current.recurringEventId){const key=current.extendedProperties!.private!.key!;if(present.has(key)||key===current.recurringEventId)continue;const restore=staleExceptionRestore(plan,source,current,scope),parent=owned.find(e=>e.id===current.recurringEventId);if(restore&&parent?.etag&&sameManagedEvent(parent,plan.items.find(i=>i.key===parent.id)!.event!)&&!plan.items.find(i=>i.key===parent.id)?.clipSeriesEtag){restore.restoreParentEtag=parent.etag;result.proposedRestores.push(restore);result.restoreEtags[restore.key]=current.etag!;result.restoreEtags[parent.id]=parent.etag;}else result.protectedAbsent++;continue;}if(present.has(current.id)||current.status==='cancelled')continue;
  let eligible=allowsSnapshotCancellation(current,scope);
  if(plan.protectedMasterKeys?.includes(current.id)||!current.etag)eligible=false;
  if(eligible){result.proposedRemovals.push(current.id);result.removalEtags[current.id]=current.etag!;result.removalTimes.push({key:current.id,start:current.start,end:current.end});}else result.protectedAbsent++;
 }
 if(result.proposedRestores.length)result.warnings.push(`${result.proposedRestores.length} veraltete Serienausnahmen: Wiederherstellung der normalen Serienzeit erst nach Bestätigung dieser Vorschau.`);
 if(scope.authority==='unknown')result.warnings.push('Unbekannter Exportumfang: fehlende Termine bleiben geschützt.');
 if(scope.basis==='clip'&&scope.boundary==='protect-boundary')result.warnings.push('Unbestätigte Endgrenze: Termine, die die Grenze berühren, bleiben geschützt.');
 if(window)result.warnings.push('Exklusives Fensterende; Serien und grenzüberschreitende Termine bleiben geschützt.');
 if(!plan.stats.components)result.warnings.push('Leerer Export: Vollständigkeit vor jeder Entfernung ausdrücklich bestätigen.');
 result.warnings.push('Entfernungen sind nur Vorschläge; diese Vorschau führt keine Absagen oder Dateibereinigung aus.');return result;
}
