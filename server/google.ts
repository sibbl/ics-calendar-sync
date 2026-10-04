import {GoogleRequestGate,isRateLimit,type RateOptions} from './google-rate-limit.js';
import {sameManagedEvent} from './event-equivalence.js';
import {GoogleRequestError,googleRequestError} from './google-request-error.js';
import {sameTime,sameRecurrence,sameSeriesZone} from './series-structure.js';
import {ExpiredCursor,type GoogleSourcePort,type SourcePage,type SourceEvent} from './google-source.js';
import type {Config} from './config.js';
import type {EventTime,Plan,Source,TargetEvent,GoogleCalendar} from '../shared/contracts.js';
import {AppError} from './errors.js';
import {FileAuthStore,type AuthCredentials} from './auth-store.js';
export interface RemoteEvent {id:string;summary?:string;location?:string;transparency?:string;visibility?:string;reminders?:{useDefault?:boolean;overrides?:unknown[]};description?:string;attendees?:unknown[];attachments?:unknown[];conferenceData?:Record<string,unknown>;hangoutLink?:string;status?:string;etag?:string;recurrence?:string[];start?:EventTime;end?:EventTime;originalStartTime?:EventTime;recurringEventId?:string;extendedProperties?:{private?:Record<string,string>};conflict?:boolean}
export const CALENDAR_LIST_SCOPE='https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export class CalendarListPermissionError extends AppError {constructor(){super('Kalenderliste nicht freigegeben. Google erneut mit calendar.calendarlist.readonly verbinden.');}}
export interface GooglePort {close?():void;successfulRun?(calendars:string[]):void;resetRateLimits?(calendars:string[]):void;getSourceEvent?:GoogleSourcePort['getSourceEvent'];listManagedEvents?(calendarId:string,sourceId:string,origin?:string):Promise<RemoteEvent[]>;listOwnedMasters?(calendarId:string,sourceId:string,origin:string):Promise<RemoteEvent[]>;readEvents?:GoogleSourcePort['readEvents'];listCalendars?():Promise<GoogleCalendar[]>;forCalendar?(calendarId:string,guard?:()=>boolean):GooglePort;get(id:string):Promise<RemoteEvent|null>;instances(parent:string,original:EventTime):Promise<RemoteEvent[]>;write(method:'POST'|'PUT'|'PATCH',id:string|undefined,body:object,etag?:string):Promise<RemoteEvent|null>}
export function owned(event:RemoteEvent|null|undefined,source:string,calendar?:string){return (!calendar||event?.extendedProperties?.private?.calendar===calendar)&&event?.extendedProperties?.private?.icsSync==='v1'&&event.extendedProperties.private.source===source;}
export {sameTime} from './series-structure.js';
export class GoogleClient implements GooglePort {
 private gate:GoogleRequestGate;
 close(){this.gate.close();}
 successfulRun(calendars:string[]){this.gate.successfulRun(calendars);}
 resetRateLimits(calendars:string[]){this.gate.resetFailures(calendars);}
 private token='';private expires=0;private refreshFlight?:Promise<string>;private store?:FileAuthStore;
 constructor(private config:Config,private fetcher:typeof fetch=fetch,rateOptions:RateOptions={}){this.gate=new GoogleRequestGate(fetcher,rateOptions);if(config.authFile)this.store=new FileAuthStore(config.authFile);}
 private async obtain(credentials:AuthCredentials,persist?:(refreshToken:string)=>void){
  const c=credentials;if(!c.clientId||!c.clientSecret||!c.refreshToken)throw new AppError('OAuth-Konfiguration unvollständig.');
  try{
   const response=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',body:new URLSearchParams({grant_type:'refresh_token',client_id:c.clientId,client_secret:c.clientSecret,refresh_token:c.refreshToken}),signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw Error();const data=await response.json() as Record<string,unknown>;
   const lifetime=Number(data.expires_in??3600);if(typeof data.access_token!=='string'||!data.access_token||!Number.isFinite(lifetime)||lifetime<=60)throw Error();
   let next=c.refreshToken;
   if(data.refresh_token!==undefined){if(typeof data.refresh_token!=='string'||!data.refresh_token||/[\r\n\0]/.test(data.refresh_token))throw Error();next=data.refresh_token;}
   if(next!==c.refreshToken){if(!persist)throw new AppError('Tokenrotation benötigt AUTH_FILE; kein Kalenderzugriff ausgeführt.');persist(next);}
   this.config.clientId=c.clientId;this.config.clientSecret=c.clientSecret;this.config.refreshToken=next;
   this.token=data.access_token;this.expires=Date.now()+(lifetime-60)*1000;return this.token;
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('OAuth-Erneuerung fehlgeschlagen; Autorisierung prüfen.');}
 }
 private async accessToken(){
  if(this.token&&Date.now()<this.expires)return this.token;if(this.refreshFlight)return this.refreshFlight;
  const operation=this.store?this.store.withLock((credentials,persist)=>this.obtain(credentials,persist)):this.obtain(this.config);
  this.refreshFlight=operation;try{return await operation;}finally{this.refreshFlight=undefined;}
 }
 private async request(method:string,path:string,body?:object,params?:Record<string,string>,etag?:string,calendarId=this.config.calendarId,guard?:()=>boolean):Promise<any>{try{
  const url=new URL('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events'+path);for(const [key,value]of Object.entries(params??{}))url.searchParams.set(key,value);
  if(body&&Object.prototype.hasOwnProperty.call(body,'conferenceData'))url.searchParams.set('conferenceDataVersion','1');if(body&&Object.prototype.hasOwnProperty.call(body,'attachments'))url.searchParams.set('supportsAttachments','true');
  const response=await this.gate.fetch(url,{method,headers:{Authorization:'Bearer '+await this.accessToken(),...body?{'Content-Type':'application/json'}:{},...etag?{'If-Match':etag}:{}},...body?{body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(30000)},guard);
  if(response.status===404||response.status===410)return null;if(response.status===409&&method==='POST')return {conflict:true};if(!response.ok){const error=await googleRequestError(response,method,path);if(method!=='GET'&&response.status>=500)error.uncertainWrites=1;throw error;}if(response.status===204)return {};try{return await response.json();}catch{if(method!=='GET'){const error=new AppError('Google-Write per HTTP bestätigt, Antwort nicht lesbar; Lauf gestoppt.');error.confirmedWrites=1;throw error;}throw new AppError('Google-Antwort nicht lesbar.');}
 }catch(error){if(error instanceof AppError)throw error;throw new AppError('Google-Verbindung fehlgeschlagen; keine Antwortdetails ausgegeben.');}}
 get(id:string){return this.request('GET','/'+encodeURIComponent(id),undefined,{fields:'id,status,etag,summary,location,transparency,visibility,reminders,description,attendees(responseStatus),attachments(mimeType),conferenceData(entryPoints(entryPointType)),hangoutLink,recurrence,start,end,recurringEventId,extendedProperties'});}
 write(method:'POST'|'PUT'|'PATCH',id:string|undefined,body:object,etag?:string){return this.request(method,id?'/'+encodeURIComponent(id):'',body,{sendUpdates:'none'},etag);}
 async instances(parent:string,original:EventTime){return this.instancesInCalendar(parent,original,this.config.calendarId);}
 private async instancesInCalendar(parent:string,original:EventTime,calendarId:string){const out:RemoteEvent[]=[],params:Record<string,string>={originalStart:original.date??original.dateTime,showDeleted:'true',maxResults:'2500',fields:'items(id,status,etag,summary,location,transparency,visibility,reminders,description,attendees(responseStatus),attachments(mimeType),conferenceData(entryPoints(entryPointType)),hangoutLink,recurrence,start,end,recurringEventId,extendedProperties,originalStartTime),nextPageToken'};for(let page=0;page<100;page++){const data=await this.request('GET','/'+encodeURIComponent(parent)+'/instances',undefined,params,undefined,calendarId);if(!data)throw new AppError('Google-Serie fehlt.');out.push(...(data.items??[]));if(!data.nextPageToken)return out;params.pageToken=data.nextPageToken;}throw new AppError('Zu viele Google-Serieninstanzen.');}
 forCalendar(calendarId:string,guard?:()=>boolean):GooglePort {
  return {get:id=>this.request('GET','/'+encodeURIComponent(id),undefined,{fields:'id,status,etag,summary,location,transparency,visibility,reminders,description,attendees(responseStatus),attachments(mimeType),conferenceData(entryPoints(entryPointType)),hangoutLink,recurrence,start,end,recurringEventId,extendedProperties'},undefined,calendarId),
   write:(method,id,body,etag)=>this.request(method,id?'/'+encodeURIComponent(id):'',body,{sendUpdates:'none'},etag,calendarId,guard),
   instances:(parent,original)=>this.instancesInCalendar(parent,original,calendarId)};
 }
 async getSourceEvent(calendarId:string,id:string):Promise<SourceEvent|null>{
  return this.request('GET','/'+encodeURIComponent(id),undefined,{fields:'id,status,etag,summary,location,attendeesOmitted,transparency,start,end,recurrence,recurringEventId,originalStartTime,attendees(responseStatus),extendedProperties/private'},undefined,calendarId);
 }
 async readEvents(calendarId:string,params:Record<string,string>):Promise<SourcePage> {
  try {
   const url=new URL('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events');
   for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
   url.searchParams.set('showHiddenInvitations','true');
   url.searchParams.set('fields','accessRole,items(id,status,etag,summary,location,attendeesOmitted,transparency,start,end,recurrence,recurringEventId,originalStartTime,attendees(responseStatus),extendedProperties/private),nextPageToken,nextSyncToken');
   const response=await this.gate.fetch(url,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+await this.accessToken()},signal:AbortSignal.timeout(30000)});
   if(response.status===410)throw new ExpiredCursor();if(!response.ok)throw await googleRequestError(response,'GET','');
   const data=await response.json();if(!['owner','writer','reader'].includes(data.accessRole))throw new AppError('Google-Quelle hat keine vollständige Termin-Leseberechtigung.');return {...data,items:data.items??[]};
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('Google-Quellabruf fehlgeschlagen.');}
 }
 async listOwnedMasters(calendarId:string,sourceId:string,origin:string){return this.listManaged(calendarId,sourceId,origin,false);}
 async listManagedEvents(calendarId:string,sourceId:string,origin?:string){return this.listManaged(calendarId,sourceId,origin,true);}
 private async listManaged(calendarId:string,sourceId:string,origin:string|undefined,comparison:boolean):Promise<RemoteEvent[]> {
  const events=new Map<string,RemoteEvent>(),seen=new Set<string>();let token='';
  try {for(let page=0;page<100;page++){
   const url=new URL('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events');
   for(const marker of ['icsSync=v1','source='+sourceId,'calendar='+calendarId,...origin!==undefined?['origin='+origin]:[]])url.searchParams.append('privateExtendedProperty',marker);
   url.searchParams.set('singleEvents','false');url.searchParams.set('showDeleted',comparison?'true':'false');url.searchParams.set('maxResults','2500');url.searchParams.set('fields',comparison?'accessRole,items(id,status,etag,summary,location,transparency,visibility,reminders,description,attendees(responseStatus),attachments(mimeType),conferenceData(entryPoints(entryPointType)),hangoutLink,recurrence,start,end,recurringEventId,originalStartTime,extendedProperties/private),nextPageToken':'accessRole,items(id,status,etag,recurringEventId,extendedProperties/private),nextPageToken');if(token)url.searchParams.set('pageToken',token);
   const response=await this.gate.fetch(url,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+await this.accessToken()},signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw await googleRequestError(response,'GET','');const data=await response.json();
   if(!['owner','writer'].includes(data.accessRole)||data.items!==undefined&&!Array.isArray(data.items))throw new AppError('Google-Zielinventar ungültig oder nicht vollständig lesbar.');
   for(const event of data.items??[]){if(!event||typeof event.id!=='string'||!event.id||events.has(event.id))throw new AppError('Google-Zielinventar widersprüchlich.');events.set(event.id,event);}
   if(events.size>10000||Buffer.byteLength(JSON.stringify([...events.values()]))>10*1024*1024)throw new AppError('Google-Zielinventar zu groß; kein Abgleich.');
   if(data.nextPageToken!==undefined&&typeof data.nextPageToken!=='string')throw new AppError('Google-Zielpaginierung ungültig.');if(!data.nextPageToken)return [...events.values()];if(typeof data.nextPageToken!=='string'||seen.has(data.nextPageToken))throw new AppError('Google-Zielpaginierung ungültig.');seen.add(data.nextPageToken);token=data.nextPageToken;
  }throw new AppError('Zu viele Google-Zielseiten.');}catch(error){if(error instanceof AppError)throw error;throw new AppError('Google-Zielinventar fehlgeschlagen.');}
 }
 async listCalendars():Promise<GoogleCalendar[]> {
  const result=new Map<string,GoogleCalendar>(),seen=new Set<string>();let next='';
  try {for(let page=0;page<100;page++){
   const url=new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
   url.searchParams.set('maxResults','250');url.searchParams.set('showHidden','true');url.searchParams.set('fields','items(id,summary,accessRole,primary),nextPageToken');if(next)url.searchParams.set('pageToken',next);
   const response=await this.gate.fetch(url,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+await this.accessToken()},signal:AbortSignal.timeout(30000)});
   if(response.status===403)throw new CalendarListPermissionError();if(!response.ok)throw new AppError('Kalenderliste nicht erreichbar (HTTP '+response.status+').');
   const data=await response.json() as {items?:unknown;nextPageToken?:unknown};
   if(data.items!==undefined&&!Array.isArray(data.items))throw new AppError('Kalenderliste ungültig.');
   for(const raw of (data.items??[]) as Record<string,unknown>[]){
    if(!raw||typeof raw.id!=='string'||!raw.id||typeof raw.summary!=='string'||!['owner','writer','reader','freeBusyReader'].includes(String(raw.accessRole)))throw new AppError('Kalenderliste ungültig.');
    const accessRole=raw.accessRole as GoogleCalendar['accessRole'];result.set(raw.id,{id:raw.id,summary:raw.summary,accessRole,primary:raw.primary===true,writable:accessRole==='owner'||accessRole==='writer'});
   }
   if(!data.nextPageToken)return [...result.values()];if(typeof data.nextPageToken!=='string'||seen.has(data.nextPageToken))throw new AppError('Kalenderlisten-Paginierung ungültig.');
   next=data.nextPageToken;seen.add(next);
  }throw new AppError('Zu viele Kalenderlisten-Seiten.');}catch(error){if(error instanceof GoogleRequestError&&error.status===403&&!isRateLimit(error))throw new CalendarListPermissionError();if(error instanceof AppError)throw error;throw new AppError('Kalenderliste nicht erreichbar; keine Antwortdetails ausgegeben.');}
 }

}
export interface SyncProgress {total:number;processed:number;changed:number;skipped:number;written:number;pending:number}
export interface SyncOptions {knownState?:RemoteEvent[];completed?:ReadonlySet<string>;uncertain?:ReadonlySet<string>;shouldContinue?:()=>boolean;progress?:(progress:SyncProgress,completedKey?:string,uncertainKey?:string)=>void}
export async function syncPlan(plan:Plan,source:Source,google:GooglePort,options:SyncOptions={}){
 const result={upserted:0,cancelled:0,absentCancelNoop:0,unchanged:0};let completedWrites=0,processed=0,changed=0,currentKey:string|undefined;
 const masters=new Map<string,RemoteEvent|null>(),parents=new Map<string,RemoteEvent>(),writtenParents=new Set<string>();
 const known=new Map((options.knownState??[]).filter(e=>!e.recurringEventId).map(e=>[e.id,e]));
 const identity=(time:EventTime|undefined)=>time?.date?'date:'+time.date:time?.dateTime?'instant:'+Date.parse(time.dateTime):'';
 const knownInstances=new Map<string,RemoteEvent[]>();for(const event of options.knownState??[]){if(!event.recurringEventId||!event.originalStartTime)continue;const key=event.recurringEventId+'|'+identity(event.originalStartTime);knownInstances.set(key,[...(knownInstances.get(key)??[]),event]);}
 const emit=(completedKey?:string,uncertainKey?:string)=>options.progress?.({total:plan.items.length,processed,changed,skipped:result.unchanged+result.absentCancelNoop,written:completedWrites,pending:plan.items.length-processed},completedKey,uncertainKey);
 const complete=(key:string)=>{processed++;emit(key);};
 const guard=()=>{if(options.shouldContinue&&!options.shouldContinue())throw new AppError('Quellkonfiguration während des Laufs geändert; vor nächstem Write gestoppt.');};
 async function trackedWrite(...args:Parameters<GooglePort['write']>){guard();const event=await google.write(...args);if(event&&!event.conflict)completedWrites++;return event;}
 function validate(current:RemoteEvent|null,item:Plan['items'][number]){
  if(current&&item.reconcileOrigin&&(!current.etag||current.recurringEventId||current.extendedProperties?.private?.origin!==item.reconcileOrigin||current.extendedProperties?.private?.key!==current.id||current.id!==item.key))throw new AppError('Reconciliation-Besitzmarkierung verändert; vor Writes gestoppt.');
  if(current&&!owned(current,source.id,source.calendarId))throw new AppError('Ziel gehört nicht dieser Quelle; Abgleich gestoppt.');if(!current||item.cancel)return;
  const before=current.recurrence??[],after=item.event!.recurrence??[];if(Boolean(before.length)!==Boolean(after.length))throw new AppError('Wechsel Einzeltermin/Serie benötigt geprüfte Migration.');
  if(source.kind!=='google'&&before.length&&(!sameRecurrence(before,after)||!sameTime(current.start,item.event!.start)||!sameTime(current.end,item.event!.end)||!sameSeriesZone(current.start,item.event!.start)||!sameSeriesZone(current.end,item.event!.end)))throw new AppError('Serienstruktur oder Masterzeit geändert. Quelle und bestehende Zielserie widersprechen sich; Abgleich gestoppt. Vorschau erneuern und vollständigen ICS-Export prüfen.');
 }
 async function update(current:RemoteEvent,item:Plan['items'][number]){const body={...item.event!,location:item.event!.location??'',description:'',attendees:[],attachments:[],conferenceData:null};if(body.recurrence&&source.kind!=='google'){delete body.recurrence;const {start:_,end:__,...metadata}=body;return trackedWrite('PATCH',item.key,metadata,current.etag);}return trackedWrite('PUT',item.key,body,current.etag);}
 const priority=(key:string)=>options.uncertain?.has(key)?-1:options.completed?.has(key)?1:0;
 const ordered=[...plan.items].sort((a,b)=>Number(!!a.parent)-Number(!!b.parent)||priority(a.key)-priority(b.key));
 try{
  emit();
  // Complete ownership/structure preflight before any write. Missing IDs in the
  // filtered owned inventory are fetched individually, retaining collision guards.
  for(const item of plan.items.filter(i=>!i.parent)){guard();const cached=known.get(item.key),current=cached?.etag?cached:await google.get(item.key);validate(current??null,item);masters.set(item.key,current??null);}
  for(const item of ordered){guard();currentKey=item.key;
   if(!item.parent){let current=masters.get(item.key)??null;
    const identical=()=>item.cancel?current?.status==='cancelled':!!current&&sameManagedEvent(current,item.event!);
    if(identical()){if(current)parents.set(item.key,current);result.unchanged++;complete(item.key);continue;}
    // A changing cached target is refreshed before mutation; If-Match retains
    // protection if another writer edits it after this final read.
    if(current&&known.has(item.key)){current=await google.get(item.key);validate(current,item);if(identical()){parents.set(item.key,current!);result.unchanged++;complete(item.key);continue;}}
    if(item.cancel){if(current){changed++;if(!await trackedWrite('PATCH',item.key,{status:'cancelled'},current.etag))throw new AppError('Absageziel verschwunden; Lauf wiederholen.');result.cancelled++;}else result.absentCancelNoop++;complete(item.key);continue;}
    changed++;let updated=current?await update(current,item):await trackedWrite('POST',undefined,{id:item.key,...item.event});
    if(updated?.conflict){current=await google.get(item.key);validate(current,item);if(!current)throw new AppError('Zielkonflikt nicht auflösbar.');if(sameManagedEvent(current,item.event!)){parents.set(item.key,current);result.unchanged++;complete(item.key);continue;}updated=await update(current,item);}
    if(!updated)throw new AppError('Ziel während des Abgleichs verschwunden.');parents.set(item.key,updated);writtenParents.add(item.key);result.upserted++;complete(item.key);
   }else{
    const parent=parents.get(item.parent)??await google.get(item.parent);if(!owned(parent,source.id,source.calendarId))throw new AppError('Serienmaster gehört nicht dieser Quelle.');
    const matches=async()=> (await google.instances(item.parent!,item.original!)).filter(e=>e.recurringEventId===item.parent&&sameTime(e.originalStartTime,item.original));
    let matching=writtenParents.has(item.parent)?await matches():knownInstances.get(item.parent+'|'+identity(item.original))??await matches();
    if(matching.length!==1)throw new AppError('Ursprüngliche Serieninstanz nicht eindeutig; keine Ersatzinstanz erzeugt.');
    const validateInstance=(current:RemoteEvent)=>{const markers=current.extendedProperties?.private;if(source.calendarId&&markers?.calendar&&markers.calendar!==source.calendarId||markers?.source&&markers.source!==source.id||markers?.icsSync&&markers.icsSync!=='v1')throw new AppError('Serieninstanz enthält fremde Besitzmarkierung.');};
    let current=matching[0]!;validateInstance(current);const identical=()=>item.cancel?current.status==='cancelled':sameManagedEvent(current,item.event!);
    if(identical()){result.unchanged++;complete(item.key);continue;}
    if(!writtenParents.has(item.parent)&&knownInstances.has(item.parent+'|'+identity(item.original))){matching=await matches();if(matching.length!==1)throw new AppError('Ursprüngliche Serieninstanz nicht eindeutig; keine Ersatzinstanz erzeugt.');current=matching[0]!;validateInstance(current);if(identical()){result.unchanged++;complete(item.key);continue;}}
    changed++;const updated=await trackedWrite(item.cancel?'PATCH':'PUT',current.id,item.cancel?{status:'cancelled'}:{...item.event!,location:item.event!.location??'',description:'',attendees:[],attachments:[],conferenceData:null},current.etag);if(!updated)throw new AppError('Serieninstanz während des Abgleichs verschwunden.');result[item.cancel?'cancelled':'upserted']++;complete(item.key);
   }
  }
  return result;
 }catch(error){if(error instanceof AppError){completedWrites+=error.confirmedWrites??0;error.confirmedWrites=completedWrites;if(error instanceof GoogleRequestError)error.completedWrites=completedWrites;if(error.uncertainWrites)emit(undefined,currentKey);else emit();error.message+=` ${completedWrites} bestätigte Writes; ${error.uncertainWrites??0} unbestätigte Writes; kein automatischer Rollback.`;}throw error;}
}
