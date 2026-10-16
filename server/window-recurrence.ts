import ICAL from 'ical.js';
import {DateTime} from 'luxon';
import type {EventTime} from '../shared/contracts.js';
import {RevisionError} from './errors.js';
import {recurrenceDates} from './clipped-series.js';
export const windowFail=():never=>{throw new RevisionError('Fensterserie nicht sicher abgleichbar; Grenzen, Zeitzone oder Wiederholungsmuster prüfen.');};
export function timed(time:EventTime|undefined){if(!time?.dateTime||!time.timeZone)return windowFail();const d=DateTime.fromISO(time.dateTime,{zone:time.timeZone});if(!d.isValid||d.getPossibleOffsets().length!==1)return windowFail();return d;}
// Floating ICAL arithmetic preserves wall time. Luxon/IANA resolves each result;
// ambiguous/nonexistent local times stop rather than guessing a DST offset.
export function windowOccurrences(event:{start?:EventTime;recurrence?:string[]},end:number){
 const start=timed(event.start),lines=event.recurrence??[],rules=lines.filter(l=>l.startsWith('RRULE:'));
 if(rules.length>1||end-start.toMillis()>100*366*86400000)return windowFail();
 const result:number[]=[];
 if(rules.length){
  const text=rules[0]!.slice(6),parts=Object.fromEntries(text.split(';').map(p=>p.split('=')));
  if(!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(parts.FREQ??'')||Object.keys(parts).some(k=>!['FREQ','COUNT','INTERVAL','BYDAY','BYMONTHDAY','BYMONTH','BYSETPOS','WKST','UNTIL'].includes(k))||parts.COUNT&&parts.UNTIL)return windowFail();
  // UTC UNTIL must be compared as an instant, not against a floating wall clock.
  const until=parts.UNTIL?DateTime.fromFormat(parts.UNTIL,"yyyyMMdd'T'HHmmss'Z'",{zone:'UTC'}).toMillis():Infinity;
  if(Number.isNaN(until))return windowFail();
  const rule=ICAL.Recur.fromString(text.split(';').filter(p=>!p.startsWith('UNTIL=')).join(';'));
  const first=ICAL.Time.fromString(start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),undefined),iter=rule.iterator(first);
  let exhausted=false;
  for(let n=0;n<40000;n++){
   const next=iter.next();if(!next){exhausted=true;break;}
   const value={year:next.year,month:next.month,day:next.day,hour:next.hour,minute:next.minute,second:next.second};
   const d=DateTime.fromObject(value,{zone:start.zoneName!});
   if(!d.isValid||d.year!==value.year||d.month!==value.month||d.day!==value.day||d.hour!==value.hour||d.minute!==value.minute||d.second!==value.second||d.getPossibleOffsets().length!==1)return windowFail();
   const ms=d.toMillis();if(ms>=end||ms>until){exhausted=true;break;}result.push(ms);
  }
  if(!exhausted)return windowFail();
 }else if(start.toMillis()<end)result.push(start.toMillis());
 const dates=recurrenceDates(lines,start.zoneName!);
 const all=[...new Set([...result,...dates.RDATE.filter(ms=>ms<end)])].sort((a,b)=>a-b);
 if(all.length>40000)return windowFail();return {all,effective:all.filter(ms=>!dates.EXDATE.includes(ms)),dates};
}
