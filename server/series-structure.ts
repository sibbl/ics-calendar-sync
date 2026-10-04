import type {EventTime} from '../shared/contracts.js';
function zone(time:EventTime|undefined){if(!time||time.date)return '';if(!time.timeZone)return '';try{return new Intl.DateTimeFormat('en',{timeZone:time.timeZone}).resolvedOptions().timeZone;}catch{return time.timeZone;}}
export function sameSeriesZone(a:EventTime|undefined,b:EventTime|undefined){return zone(a)===zone(b);}
function canonical(line:string){
 const colon=line.indexOf(':');if(colon<0)return line;const prefix=line.slice(0,colon).toUpperCase(),value=line.slice(colon+1);
 if(/^(RDATE|EXDATE)(;[^:]*)?$/.test(prefix)){return prefix+':'+value.split(',').sort().join(',');}
 if(prefix!=='RRULE'&&prefix!=='EXRULE')return line;
 const entries=value.toUpperCase().split(';').map(part=>part.split('='));
 if(entries.some(p=>p.length!==2)||new Set(entries.map(p=>p[0])).size!==entries.length)return line;
 return prefix+':'+entries.filter(([key,val])=>!(key==='INTERVAL'&&val==='1')&&!(key==='WKST'&&val==='MO')).map(([key,val])=>key+'='+val!.split(',').sort().join(',')).sort().join(';');
}
export function canonicalRecurrence(lines:string[]){return lines.map(canonical).sort();}
export function sameRecurrence(a:string[],b:string[]){return JSON.stringify(canonicalRecurrence(a))===JSON.stringify(canonicalRecurrence(b));}

export function sameTime(a:EventTime|undefined,b:EventTime|undefined){if(!a||!b)return false;if(a.date||b.date)return a.date===b.date;const aa=Date.parse(a.dateTime!),bb=Date.parse(b.dateTime!);return Number.isFinite(aa)&&Number.isFinite(bb)&&aa===bb;}
