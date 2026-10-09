import {DateTime} from 'luxon';
import {RevisionError} from './errors.js';
import type {RemoteEvent} from './google.js';
import {clipScope} from './clip-window.js';
import {validatedWindow} from './snapshot-preview.js';
import {sameRecurrence,sameTime,sameSeriesZone} from './series-structure.js';
import {stampFingerprint} from './event-fingerprint.js';
import type {EventTime,Plan,Source} from '../shared/contracts.js';
const fail=():never=>{throw new RevisionError('Clip-Serie nicht sicher abgleichbar; vollständigen Export oder geprüfte Migration verwenden.');};
const weekdays=['MO','TU','WE','TH','FR','SA','SU'];
function local(t:EventTime|undefined){if(!t||t.date||!t.timeZone) return fail();const d=DateTime.fromISO(t.dateTime,{zone:t.timeZone});if(!d.isValid)return fail();return d;}
// Deliberately bounded subset. More complex rules retain the existing hard stop.
export function occurrences(event:{start?:EventTime;recurrence?:string[]},until=Infinity){
 const start=local(event.start),lines=event.recurrence??[];const rules=lines.filter(r=>r.startsWith('RRULE:'));
 if(rules.length!==1||lines.some(r=>! /^(RRULE:|(?:EXDATE|RDATE)(?:;[^:]*)?:)/.test(r)))return fail();
 const parts=rules[0]!.slice(6).split(';').map(p=>p.split('='));const r:Record<string,string>=Object.fromEntries(parts);
 if(parts.some(p=>p.length!==2)||Object.keys(r).length!==parts.length||r.FREQ!=='WEEKLY'||Object.keys(r).some(k=>!['FREQ','COUNT','INTERVAL','BYDAY','WKST'].includes(k)))return fail();
 if(!/^[1-9]\d*$/.test(r.COUNT??'')||! /^(?:[1-9]\d*)$/.test(r.INTERVAL??'1'))return fail();
 const count=Number(r.COUNT),interval=Number(r.INTERVAL??1);if(count>1000||interval>52)return fail();
 const wkst=weekdays.indexOf(r.WKST??'MO'),days=(r.BYDAY??weekdays[start.weekday-1]!).split(',').map(d=>weekdays.indexOf(d));
 if(wkst<0||days.some(d=>d<0)||new Set(days).size!==days.length||!days.includes(start.weekday-1))return fail();
 const weekStart=start.minus({days:(start.weekday-1-wkst+7)%7});const offsets=days.map(d=>(d-wkst+7)%7).sort((a,b)=>a-b);const out:number[]=[];
 for(let w=0;out.length<count&&w<=count;w++)for(const offset of offsets){const d=weekStart.plus({weeks:w*interval,days:offset});if(d.toMillis()<start.toMillis())continue;if(d.toMillis()>until)return out;if(d.toFormat('HH:mm:ss')!==start.toFormat('HH:mm:ss')||d.getPossibleOffsets().length!==1)return fail();out.push(d.toMillis());if(out.length===count)break;}
 if(out.length!==count)return fail();return out;
}
export function recurrenceDates(lines:string[],zone:string){const result:{EXDATE:number[];RDATE:number[]}={EXDATE:[],RDATE:[]};
 for(const line of lines){const m=/^(EXDATE|RDATE)(?:;TZID=([^;:]+))?:(.+)$/.exec(line);if(!m){if(!line.startsWith('RRULE:'))return fail();continue;}
  for(const raw of m[3]!.split(',')){if(!/^\d{8}T\d{6}Z?$/.test(raw))return fail();const z=raw.endsWith('Z')?'UTC':m[2]??zone;const d=DateTime.fromFormat(raw.replace(/Z$/,''),"yyyyMMdd'T'HHmmss",{zone:z});if(!d.isValid||d.getPossibleOffsets().length!==1)return fail();result[m[1] as 'EXDATE'|'RDATE'].push(d.toMillis());}}
 return result;
}
export function preserveClippedSeries(plan:Plan,source:Source,target:RemoteEvent[]):Plan{
 if(source.clipSeriesMode!=='preserve-master'||!source.snapshotClip)return plan;
 const scope=clipScope(plan,source),window=validatedWindow(scope);if(!window||scope.authority!=='window')return fail();
 const result=structuredClone(plan),known=new Map(target.filter(e=>!e.recurringEventId).map(e=>[e.id,e]));let normalized=0,added=0,cancelled=0;
 for(const item of result.items){if(item.cancel||item.parent||!item.event?.recurrence?.length)continue;const old=known.get(item.key);if(!old?.recurrence?.length)continue;
  const next=item.event;if(sameRecurrence(old.recurrence,next.recurrence!)&&sameTime(old.start,next.start)&&sameTime(old.end,next.end)&&sameSeriesZone(old.start,next.start)&&sameSeriesZone(old.end,next.end))continue;
  if(!(old.extendedProperties?.private?.icsSync==='v1'&&old.extendedProperties.private.source===source.id&&old.extendedProperties.private.calendar===source.calendarId)||!old.etag||old.status==='cancelled'||old.extendedProperties?.private?.key!==old.id)return fail();
  const a=local(old.start),b=local(next.start),ae=local(old.end),be=local(next.end);
  if(!sameSeriesZone(old.start,next.start)||!sameSeriesZone(old.end,next.end)||a.toFormat('HH:mm:ss')!==b.toFormat('HH:mm:ss')||ae.toMillis()-a.toMillis()!==be.toMillis()-b.toMillis()||a.toMillis()>b.toMillis())return fail();
  const inside=(ms:number)=>ms>=window.startMillis&&(scope.boundary==='protect-boundary'?ms+(ae.toMillis()-a.toMillis())<window.endMillis:ms+(ae.toMillis()-a.toMillis())<=window.endMillis);
  const aa=occurrences(old).filter(inside),bb=occurrences(next).filter(inside);
  const withoutCount=(lines:string[])=>lines.filter(r=>r.startsWith('RRULE:')).map(r=>'RRULE:'+r.slice(6).split(';').filter(p=>!p.startsWith('COUNT=')).join(';'));
  const oldDates=recurrenceDates(old.recurrence,a.zoneName!),newDates=recurrenceDates(next.recurrence!,b.zoneName!);
  // A finite RRULE may have ended while explicit RDATE occurrences still lie
  // in the clip. Validate the effective recurrence, not just the RRULE grid.
  if(!sameRecurrence(withoutCount(old.recurrence),withoutCount(next.recurrence!))||!bb.length&&!newDates.RDATE.some(ms=>inside(ms)&&!newDates.EXDATE.includes(ms)))return fail();
  const grid=occurrences({...old,recurrence:old.recurrence.map(r=>r.startsWith('RRULE:')?r.replace(/COUNT=[1-9]\d*/, 'COUNT=1000'):r)},Math.max(b.toMillis(),...bb));
  if(!grid.includes(b.toMillis())||bb.some(ms=>!grid.includes(ms)))return fail();
  const merged=old.recurrence.filter(r=>r.startsWith('RRULE:'));
  const desired=new Set([...bb,...newDates.RDATE.filter(inside)].filter(ms=>!newDates.EXDATE.includes(ms)));
  const previous=new Set([...aa,...oldDates.RDATE.filter(inside)].filter(ms=>!oldDates.EXDATE.includes(ms)));
  added+=[...desired].filter(ms=>!previous.has(ms)).length;cancelled+=[...previous].filter(ms=>!desired.has(ms)).length;
  const inferred={EXDATE:aa.filter(ms=>!desired.has(ms)),RDATE:[...desired].filter(ms=>!aa.includes(ms))};
  for(const type of ['EXDATE','RDATE'] as const){if(newDates[type].some(ms=>!inside(ms)&&!oldDates[type].includes(ms)))return fail();const dates=[...new Set([...oldDates[type].filter(ms=>!inside(ms)),...newDates[type].filter(ms=>inside(ms)&&(type!=='RDATE'||!newDates.EXDATE.includes(ms))),...inferred[type]])].sort((a,b)=>a-b);if(dates.length)merged.push(type+':'+dates.map(ms=>DateTime.fromMillis(ms,{zone:'UTC'}).toFormat("yyyyMMdd'T'HHmmss'Z'")).join(','));}
  const mergedDates=recurrenceDates(merged,a.zoneName!);
  const dateSet=(values:number[])=>JSON.stringify([...new Set(values)].sort((a,b)=>a-b));
  // Google normalizes UTC exception dates into local TZID lines. Preserve its
  // exact representation when the instant sets are unchanged, avoiding a new
  // migration approval or write solely for serialization differences.
  if((['EXDATE','RDATE'] as const).every(type=>dateSet(oldDates[type])===dateSet(mergedDates[type])))merged.splice(0,merged.length,...old.recurrence);
  item.event=stampFingerprint({...next,start:old.start!,end:old.end!,recurrence:merged},source.rules);
  if(!sameRecurrence(old.recurrence,merged)){item.clipSeriesEtag=old.etag;item.clipSeriesInput=structuredClone(next);}
  normalized++;
 }
 result.stats.normalizedClipSeries=normalized;result.stats.clipOccurrencesAdded=added;result.stats.clipOccurrencesCancelled=cancelled;
 if(normalized)result.warnings.push('Clip-Serien: bestehender Master und Wiederholungen außerhalb des Fensters bleiben erhalten; Ausnahmedaten werden nur innerhalb des bestätigten Fensters abgeglichen.');
 return result;
}
// Re-evaluate the bounded transformation against a fresh ETag before mutation.
export function validateClippedSeries(current:RemoteEvent,item:Plan['items'][number],source:Source,plan:Plan){
 if(!item.clipSeriesEtag||current.etag!==item.clipSeriesEtag)return false;
 // The original unnormalized event is kept only in the in-memory plan.
 if(!item.clipSeriesInput)return false;
 try{const probe=preserveClippedSeries({...plan,items:[{...item,event:item.clipSeriesInput,clipSeriesEtag:undefined,clipSeriesInput:undefined}]},source,[current]);return sameRecurrence(probe.items[0]!.event!.recurrence??[],item.event!.recurrence??[])&&sameTime(current.start,item.event!.start)&&sameTime(current.end,item.event!.end);}catch{return false;}
}
