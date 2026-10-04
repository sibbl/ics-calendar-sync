import {ownershipMarkers} from './event-fingerprint.js';
import type {RemoteEvent} from './google.js';
import type {TargetEvent} from '../shared/contracts.js';
import {sameTime,sameSeriesZone,sameRecurrence} from './series-structure.js';
function entries(value:Record<string,string>|undefined){return JSON.stringify(Object.entries(ownershipMarkers(value)).sort(([a],[b])=>a.localeCompare(b)));}
export function sameManagedEvent(current:RemoteEvent,desired:TargetEvent){
 const recurring=!!desired.recurrence?.length;
 const timeZoneMatches=(a:RemoteEvent['start'],b:TargetEvent['start'])=>!recurring&&(!a?.timeZone||!b.timeZone)||sameSeriesZone(a,b);
 // Omitted default-valued Calendar fields normalize to their documented defaults.
 // Missing explicit privacy/reminder fields, or unexpected private content, are
 // deliberately conservative: they must not authorize skipping a privacy update.
 return (current.status??'confirmed')===desired.status
  &&(current.summary??'')===desired.summary&&(current.location??'')===(desired.location??'')
  &&sameTime(current.start,desired.start)&&sameTime(current.end,desired.end)
  &&timeZoneMatches(current.start,desired.start)&&timeZoneMatches(current.end,desired.end)
  &&sameRecurrence(current.recurrence??[],desired.recurrence??[])
  &&(current.transparency??'opaque')===desired.transparency&&current.visibility===desired.visibility
  &&current.reminders?.useDefault===false&&!current.reminders.overrides?.length
  &&entries(current.extendedProperties?.private)===entries(desired.extendedProperties.private)
  &&!current.description&&!current.attendees?.length&&!current.attachments?.length
  &&!current.hangoutLink&&(!current.conferenceData||!Object.keys(current.conferenceData).length);
}
