import {clipInstant} from './clip-window.js';
import {stampFingerprint} from './event-fingerprint.js';
import {compileTextRules,expression} from './text-rules.js';
import {anonymousTitle} from './event-title.js';
import {createHash} from 'node:crypto';
import {DateTime,IANAZone} from 'luxon';
import safeRegex from 'safe-regex2';
import type {Rules,EventTime,Plan,Item,TargetEvent} from '../shared/contracts.js';
import {rulesSchema} from '../shared/contracts.js';
import {AppError,MAX_BYTES} from './errors.js';
type Property={name:string;params:Record<string,string>;value:string};
type Component={name:string;properties:Property[];children:Component[]};
function fail(message:string):never{throw new AppError(message);}
export function opaque(...parts:string[]){const bytes=createHash('sha256').update(parts.join('\0')).digest();const alphabet='0123456789abcdefghijklmnopqrstuv';let bits=0,value=0,result='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){bits-=5;result+=alphabet[(value>>>bits)&31];}}if(bits)result+=alphabet[(value<<(5-bits))&31];return result;}
function split(text:string,separator:string){let quoted=false,out:string[]=[],value='';for(const c of text){if(c==='"')quoted=!quoted;if(c===separator&&!quoted){out.push(value);value='';}else value+=c;}if(quoted)fail('ICS-Parameter ungültig.');out.push(value);return out;}
function parseContent(data:Uint8Array):Component{
 if(!data.length||data.length>MAX_BYTES)fail('Quelle leer oder größer als 10 MiB.');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(data).replace(/^\uFEFF/,'').replace(/\r?\n[ \t]/g,'');
 const lines=text.trim().split(/\r?\n/);const stack:Component[]=[];let root:Component|undefined;
 for(const line of lines){if(!line)continue;let quoted=false,colon=-1;for(let i=0;i<line.length;i++){if(line[i]==='"')quoted=!quoted;if(line[i]===':'&&!quoted){colon=i;break;}}if(colon<1)fail('ICS-Inhaltszeile ungültig.');
 const headers=split(line.slice(0,colon),';'),name=headers.shift()!.toUpperCase(),value=line.slice(colon+1);
 if(name==='BEGIN'){const component:Component={name:value.toUpperCase(),properties:[],children:[]};if(stack.length)stack.at(-1)!.children.push(component);else{if(root)fail('Mehrere Kalenderhüllen.');root=component;}stack.push(component);}
 else if(name==='END'){if(stack.pop()?.name!==value.toUpperCase())fail('ICS-Komponenten nicht vollständig.');}
 else{if(!stack.length)fail('ICS-Komponente fehlt.');const params:Record<string,string>={};for(const header of headers){const equal=header.indexOf('=');if(equal<1)fail('ICS-Parameter ungültig.');params[header.slice(0,equal).toUpperCase()]=header.slice(equal+1).replace(/^"|"$/g,'');}stack.at(-1)!.properties.push({name,params,value});}}
 if(stack.length||root?.name!=='VCALENDAR'||lines[0]!=='BEGIN:VCALENDAR'||lines.at(-1)!=='END:VCALENDAR')fail('Keine vollständige ICS-Kalenderdatei.');return root;
}
const props=(c:Component,key:string)=>c.properties.filter(p=>p.name===key);
function single(c:Component,key:string){const values=props(c,key);if(values.length>1)fail('Mehrfaches Einzelwertfeld ist nicht unterstützt.');return values[0];}
const value=(c:Component,key:string,fallback='')=>single(c,key)?.value??fallback;
const unescape=(s:string)=>s.replace(/\\[nN]/g,'\n').replace(/\\([,;\\])/g,'$1');
interface ParsedTime {dt:DateTime;date:boolean;zone:string;target:EventTime;identity:string}
function time(property:Property|undefined,rules:Rules):ParsedTime{
 if(!property)fail('Zeitfeld fehlt.');const raw=property.value;
 if(property.params.VALUE==='DATE'||/^\d{8}$/.test(raw)){if(!/^\d{8}$/.test(raw))fail('Datumsfeld ungültig.');const dt=DateTime.fromFormat(raw,'yyyyMMdd',{zone:'UTC'});if(!dt.isValid||dt.toFormat('yyyyMMdd')!==raw)fail('Datumsfeld ungültig.');return {dt,date:true,zone:'UTC',target:{date:dt.toISODate()!},identity:dt.toISODate()!};}
 if(!/^\d{8}T\d{6}Z?$/.test(raw))fail('Zeitfeld ungültig.');
 const tzid=property.params.TZID;const zone=raw.endsWith('Z')?'UTC':tzid==='W. Europe Standard Time'?'Europe/Berlin':tzid||rules.floatingTimezone;
 if(!IANAZone.isValidZone(zone)&&zone!=='UTC')fail('Unbekannte Zeitzone; IANA-Zuordnung erforderlich.');
 const format="yyyyMMdd'T'HHmmss";let dt=DateTime.fromFormat(raw.replace(/Z$/,''),format,{zone});if(!dt.isValid||dt.toFormat(format)!==raw.replace(/Z$/,''))fail('Lokale Zeit ist ungültig oder liegt in einer Sommerzeitlücke.');
 if(tzid==='W. Europe Standard Time'&&dt.year<1980)fail('Historische Windows-Zeitzone nicht unterstützt.');
 const choices=dt.getPossibleOffsets().sort((a,b)=>a.toMillis()-b.toMillis());if(!tzid&&!raw.endsWith('Z')&&choices.length>1)fail('Floating-Zeit ist bei Zeitumstellung mehrdeutig.');if(choices.length>1)dt=choices[0]!;
 return {dt,date:false,zone,target:{dateTime:dt.toISO({suppressMilliseconds:true})!,timeZone:zone},identity:dt.toUTC().toISO({suppressMilliseconds:true})!};
}
function busy(c:Component,master:Component,rules:Rules){if(rules.busyMode==='all')return true;const transp=value(c,'TRANSP',value(master,'TRANSP','OPAQUE')).toUpperCase();if(rules.busyMode==='rfc')return transp!=='TRANSPARENT';const inherited=c===master||!single(c,'TRANSP')?value(master,'X-MICROSOFT-CDO-BUSYSTATUS'):'';const state=value(c,'X-MICROSOFT-CDO-BUSYSTATUS',inherited);return state?state.toUpperCase()==='BUSY':transp!=='TRANSPARENT';}
function recurrence(master:Component,start:ParsedTime,rules:Rules):string[]{
 if(props(master,'EXRULE').length||props(master,'RRULE').length>1)fail('EXRULE oder mehrere RRULEs werden nicht unterstützt.');const out:string[]=[];
 for(const property of master.properties){if(property.name==='RRULE'){
 const entries=property.value.toUpperCase().split(';').map(v=>v.split('='));const map:Record<string,string>=Object.fromEntries(entries);
 if(entries.some(v=>v.length!==2)||new Set(entries.map(v=>v[0])).size!==entries.length||!['SECONDLY','MINUTELY','HOURLY','DAILY','WEEKLY','MONTHLY','YEARLY'].includes(map.FREQ??'')||map.COUNT&&map.UNTIL)fail('Wiederholungsregel ungültig.');
 const supported=['FREQ','UNTIL','COUNT','INTERVAL','BYSECOND','BYMINUTE','BYHOUR','BYDAY','BYMONTHDAY','BYYEARDAY','BYWEEKNO','BYMONTH','BYSETPOS','WKST'];if(entries.some(([key])=>!supported.includes(key!)))fail('Wiederholungsregel nicht unterstützt.');
 for(const key of ['COUNT','INTERVAL'])if(map[key]&&!/^[1-9]\d*$/.test(map[key]!))fail('Wiederholungsregel ungültig.');
 if(map.UNTIL){const until=time({name:'UNTIL',params:start.date?{VALUE:'DATE'}:{},value:map.UNTIL},rules);if(until.date!==start.date||!start.date&&!map.UNTIL.endsWith('Z'))fail('UNTIL-Zeittyp ungültig.');}
 for(const [key,min,max,noZero] of [['BYSECOND',0,60,false],['BYMINUTE',0,59,false],['BYHOUR',0,23,false],['BYMONTHDAY',-31,31,true],['BYYEARDAY',-366,366,true],['BYWEEKNO',-53,53,true],['BYMONTH',1,12,false],['BYSETPOS',-366,366,true]] as const)if(map[key]&&map[key]!.split(',').some(x=>!/^[-+]?\d+$/.test(x)||Number(x)<min||Number(x)>max||noZero&&Number(x)===0))fail('Wiederholungsregel ungültig.');
 if(map.BYDAY&&map.BYDAY.split(',').some(x=>!/^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(x)))fail('BYDAY ungültig.');if(map.WKST&&!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(map.WKST))fail('WKST ungültig.');out.push('RRULE:'+property.value.toUpperCase());
 }else if(property.name==='RDATE'||property.name==='EXDATE'){
 const values=property.value.split(',').map(raw=>time({...property,value:raw},rules));if(values.some(v=>v.date!==start.date))fail('Wiederholungsdatum und Master haben unterschiedliche Zeittypen.');out.push(property.name+(start.date?';VALUE=DATE:':':')+values.map(v=>v.date?v.dt.toFormat('yyyyMMdd'):v.dt.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")).join(','));
 }}return out;
}
function duration(raw:string,dateOnly=false){const match=/^P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(raw);if(!match||!match.slice(1).some(Boolean))fail('Dauer ungültig.');const delta={weeks:Number(match[1]||0),days:Number(match[2]||0),hours:Number(match[3]||0),minutes:Number(match[4]||0),seconds:Number(match[5]||0)};if(dateOnly&&(delta.hours||delta.minutes||delta.seconds))fail('Ganztägige Dauer muss aus Tagen oder Wochen bestehen.');return delta;}
export function parseCalendar(data:Uint8Array,sourceId:string,inputRules:Partial<Rules>={},calendarId?:string):Plan{
 try{
 const rules=rulesSchema.parse(inputRules);const textRules=compileTextRules(rules);if(rules.excludeRegex&&!safeRegex(rules.excludeRegex))fail('Filter-RegEx ist ungültig oder benötigt zu viel Rechenzeit.');let regex:ReturnType<typeof expression>|undefined;try{regex=rules.excludeRegex?expression(rules.excludeRegex,'iu'):undefined;}catch(error){if(error instanceof AppError)throw error;fail('Filter-RegEx ungültig.');}
 const root=parseContent(data),clipStart=single(root,'X-CLIPSTART'),clipEnd=single(root,'X-CLIPEND');let clipWindow:Plan['clipWindow'];if(clipStart||clipEnd){if(!clipStart||!clipEnd||[clipStart,clipEnd].some(p=>Object.entries(p.params).some(([k,v])=>k!=='VALUE'||v!=='DATE-TIME')))fail('Clip-Grenzen fehlen oder haben uneindeutige Parameter.');clipWindow={start:clipInstant(clipStart.value),end:clipInstant(clipEnd.value)};if(clipWindow.start>=clipWindow.end)fail('Clip-Fenster ungültig.');}const events=root.children.filter(c=>c.name==='VEVENT');if(events.length>10000)fail('Zu viele Termine.');
 // Custom timezone definitions cannot override the IANA database silently.
 for(const zone of root.children.filter(c=>c.name==='VTIMEZONE')){const id=value(zone,'TZID');if(id==='W. Europe Standard Time'||id==='Europe/Berlin'){
  const standard=zone.children.find(c=>c.name==='STANDARD'),daylight=zone.children.find(c=>c.name==='DAYLIGHT');if(!standard||!daylight||value(standard,'TZOFFSETFROM')!=='+0200'||value(standard,'TZOFFSETTO')!=='+0100'||value(daylight,'TZOFFSETFROM')!=='+0100'||value(daylight,'TZOFFSETTO')!=='+0200'||!value(standard,'RRULE').includes('BYMONTH=10')||!value(standard,'RRULE').includes('BYDAY=-1SU')||!value(daylight,'RRULE').includes('BYMONTH=3')||!value(daylight,'RRULE').includes('BYDAY=-1SU'))fail('Windows-Zeitzonendefinition widerspricht der IANA-Zuordnung.');
 }else fail('Eingebettete VTIMEZONE nicht unterstützt; geprüfte IANA-Zuordnung erforderlich.');}
 const groups=new Map<string,Component[]>();for(const event of events){const uid=unescape(value(event,'UID'));if(!uid||uid.length>4096)fail('UID fehlt oder ist ungültig.');groups.set(uid,[...(groups.get(uid)??[]),event]);}
 const items:Item[]=[];let exceptions=0;
 const excluded=(c:Component,m:Component)=>{const title=unescape(value(c,'SUMMARY',value(m,'SUMMARY'))),match=regex?.exec(title);return (!!match&&(rules.excludeRegex!=='^Mittagspause$'||match[0]!.length===title.length))||textRules.excludesLocation(unescape(value(c,'LOCATION',value(m,'LOCATION'))));};
 for(const [uid,group]of groups){const masters=group.filter(c=>!single(c,'RECURRENCE-ID'));if(masters.length!==1)fail('Doppelte Master oder verwaiste Serienausnahme.');const master=masters[0]!,key=calendarId?opaque(sourceId,calendarId,uid):opaque(sourceId,uid);const children=group.filter(c=>c!==master);exceptions+=children.length;
 const cancelled=value(root,'METHOD').toUpperCase()==='CANCEL'||value(master,'STATUS').toUpperCase()==='CANCELLED';const selected=busy(master,master,rules)&&!excluded(master,master);
 if(!cancelled&&!selected&&children.some(c=>value(c,'STATUS').toUpperCase()!=='CANCELLED'&&busy(c,master,rules)&&!excluded(c,master)))fail('Ausgewählte Ausnahme bei ausgefiltertem Master; explizite Serienaufteilung erforderlich.');
 if(cancelled||!selected){items.push({key,cancel:true});continue;}
 const start=time(single(master,'DTSTART'),rules);const recurrences=recurrence(master,start,rules);
 if(single(master,'DTEND')&&single(master,'DURATION'))fail('DTEND und DURATION dürfen nicht gemeinsam gesetzt sein.');
 const masterEnd=single(master,'DTEND')?time(single(master,'DTEND'),rules):{...start,dt:start.dt.plus(single(master,'DURATION')?duration(value(master,'DURATION'),start.date):start.date?{days:1}:{seconds:0})};
 const seen=new Set<string>();
 for(const event of [master,...children]){
 const rid=event===master?undefined:single(event,'RECURRENCE-ID');let original:ParsedTime|undefined;
 if(rid){if(rid.params.RANGE||!recurrences.length)fail('RANGE oder Ausnahme ohne native Serie nicht unterstützt.');original=time(rid,rules);if(original.date!==start.date)fail('RECURRENCE-ID und Master haben unterschiedliche Zeittypen.');if(seen.has(original.identity))fail('Doppelte Serienausnahme.');seen.add(original.identity);}
 const id=original?(calendarId?opaque(sourceId,calendarId,uid,original.identity):opaque(sourceId,uid,original.identity)):key;const cancel=value(event,'STATUS').toUpperCase()==='CANCELLED'||!busy(event,master,rules)||excluded(event,master);
 const common={key:id,...original?{parent:key,original:original.target}:{},cancel};if(cancel){items.push(common);continue;}
 const begin=single(event,'DTSTART')?time(single(event,'DTSTART'),rules):original??start;
 if(single(event,'DTEND')&&single(event,'DURATION'))fail('DTEND und DURATION dürfen nicht gemeinsam gesetzt sein.');
 let end:ParsedTime;if(single(event,'DTEND'))end=time(single(event,'DTEND'),rules);else{const inheritedDuration=single(event,'DURATION')??single(master,'DURATION');const dt=inheritedDuration?begin.dt.plus(duration(inheritedDuration.value,begin.date)):begin.dt.plus({milliseconds:masterEnd.dt.toMillis()-start.dt.toMillis()});end={...begin,dt,target:begin.date?{date:dt.toISODate()!}:{dateTime:dt.toISO({suppressMilliseconds:true})!,timeZone:begin.zone}};}
 if(begin.date!==end.date||begin.date!==start.date||end.dt.toMillis()<=begin.dt.toMillis())fail('Zeittypen oder Endzeit ungültig.');
 const attendees=value(event,'X-ICS-SYNC-ATTENDANCE')==='UNKNOWN'?[]:props(event,'ATTENDEE').length?props(event,'ATTENDEE'):props(master,'ATTENDEE');const knownStatuses=new Set(['ACCEPTED','DECLINED','TENTATIVE','NEEDS-ACTION','DELEGATED']);const count=attendees.length&&attendees.every(p=>knownStatuses.has(p.params.PARTSTAT?.toUpperCase()??''))?attendees.filter(p=>p.params.PARTSTAT?.toUpperCase()==='ACCEPTED').length:undefined;const location=unescape(value(event,'LOCATION',value(master,'LOCATION')));
 const mapped=textRules.transform(unescape(value(event,'SUMMARY',value(master,'SUMMARY'))),location);
 const body:TargetEvent={summary:(mapped.title??'Termin')+anonymousTitle(rules.acceptedCount,count).slice('Termin'.length),...(rules.includeLocation&&mapped.location?{location:mapped.location}:{}),start:begin.target,end:end.target,status:'confirmed',transparency:'opaque',visibility:'private',reminders:{useDefault:false},extendedProperties:{private:{icsSync:'v1',source:sourceId,key:id,...calendarId?{calendar:calendarId}:{}}},...event===master&&recurrences.length?{recurrence:recurrences}:{}};
 items.push({...common,event:stampFingerprint(body,rules)});
 }}
 const warnings=['Fehlende UIDs und Ausnahmen lösen keine Löschungen aus.'];if(rules.transforms?.some(r=>r.field==='title'))warnings.push('Titeltransforms sind bewusst freigegeben: nicht ersetzte Textteile können Originaltitel enthalten. Vorschau vor Übernahme prüfen.');if(root.properties.some(p=>['X-CLIPSTART','X-CLIPEND','X-CALSTART','X-CALEND'].includes(p.name)))warnings.push('Begrenzter Export: bestehende Serienstruktur darf nicht verkürzt werden.');if(!events.some(c=>props(c,'ATTENDEE').length))warnings.push('Keine vollständigen Teilnehmerdaten: Zusageanzahl wird weggelassen.');
 return {...clipWindow?{clipWindow}:{},items,stats:{components:events.length,uids:groups.size,exceptions,upserts:items.filter(i=>!i.cancel).length,explicitCancellations:items.filter(i=>i.cancel).length},warnings};
 }catch(error){if(error instanceof AppError)throw error;throw new AppError('ICS oder Regel ungültig; Quelle wird vollständig übersprungen.');}
}
