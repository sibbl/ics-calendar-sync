import {DateTime} from 'luxon';
import type {Item,Plan,Source} from '../shared/contracts.js';
import type {RemoteEvent} from './google.js';
import {occurrences,recurrenceDates} from './clipped-series.js';
import {allowsSnapshotCancellation,type SnapshotScope} from './snapshot-preview.js';
import {stampFingerprint} from './event-fingerprint.js';
import {sameTime} from './series-structure.js';
import {sameManagedEvent} from './event-equivalence.js';
// Missing exceptions are not deletions. Only an owned exception with a present,
// supported master and an explicitly complete bounded snapshot can be restored.
export function staleExceptionRestore(plan:Plan,source:Source,current:RemoteEvent,scope:SnapshotScope):Item|undefined {
 try {
  const p=current.extendedProperties?.private,parent=plan.items.find(i=>i.key===current.recurringEventId&&!i.parent&&!i.cancel);
  if(scope.authority!=='window'||!parent?.event||plan.protectedMasterKeys?.includes(parent.key)||!current.etag||!p||p.icsSync!=='v1'||p.source!==source.id||p.calendar!==source.calendarId||p.origin||!p.key||p.key===parent.key||plan.items.some(i=>i.key===p.key||i.parent===parent.key&&sameTime(i.original,current.originalStartTime)))return;
  const original=current.originalStartTime;if(!original?.dateTime||!original.timeZone)return;
  const master=parent.event,start=DateTime.fromISO(original.dateTime,{zone:master.start.timeZone}),a=DateTime.fromISO(master.start.dateTime!,{zone:master.start.timeZone}),b=DateTime.fromISO(master.end.dateTime!,{zone:master.end.timeZone});
  if(!start.isValid||!a.isValid||!b.isValid||b.toMillis()<=a.toMillis()||start.getPossibleOffsets().length!==1)return;
  const ms=start.toMillis(),dates=recurrenceDates(master.recurrence??[],a.zoneName!);
  if(dates.EXDATE.includes(ms)||!dates.RDATE.includes(ms)&&!occurrences(master,ms).includes(ms))return;
  const event=stampFingerprint({...structuredClone(master),start:{dateTime:start.toISO()!,timeZone:a.zoneName!},end:{dateTime:start.plus({milliseconds:b.toMillis()-a.toMillis()}).toISO()!,timeZone:a.zoneName!},extendedProperties:{private:{...master.extendedProperties.private,key:p.key}},recurrence:undefined},source.rules);
  if(!allowsSnapshotCancellation({...current,recurringEventId:undefined,recurrence:undefined},scope)||!allowsSnapshotCancellation({id:current.id,...event},scope)||sameManagedEvent(current,event))return;
  return {key:p.key,parent:parent.key,original,cancel:false,event,restoreEtag:current.etag,restoreScope:scope};
 }catch{return;}
}
