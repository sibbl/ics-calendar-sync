import {createHash} from 'node:crypto';
import type {Rules,TargetEvent,EventTime} from '../shared/contracts.js';
import {canonicalRecurrence} from './series-structure.js';
export const MAPPING_VERSION='ics-mapping-v2';
export function stableJSON(value:unknown):string {if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stableJSON(v)).join(',')+'}';return JSON.stringify(value)??'null';}
function digest(value:unknown){return createHash('sha256').update(stableJSON(value)).digest('hex');}
function time(value:EventTime){if(value.date)return {date:value.date};return {dateTime:new Date(value.dateTime!).toISOString(),timeZone:new Intl.DateTimeFormat('en',{timeZone:value.timeZone}).resolvedOptions().timeZone};}
export function ownershipMarkers(markers:Record<string,string>|undefined){return Object.fromEntries(Object.entries(markers??{}).filter(([key])=>!['desiredHash','mappingHash','hashVersion'].includes(key)));}
export function stampFingerprint(event:TargetEvent,rules:Rules){
 const mappingHash=digest([MAPPING_VERSION,rules]);
 const desiredHash=digest({version:MAPPING_VERSION,mappingHash,summary:event.summary,location:event.location??'',start:time(event.start),end:time(event.end),recurrence:canonicalRecurrence(event.recurrence??[]),status:event.status,transparency:event.transparency,visibility:event.visibility,reminders:event.reminders,ownership:ownershipMarkers(event.extendedProperties.private)});
 Object.assign(event.extendedProperties.private,{desiredHash,mappingHash,hashVersion:MAPPING_VERSION});return event;
}
