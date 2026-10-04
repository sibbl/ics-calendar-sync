import {opaque} from './calendar.js';
import {stableJSON} from './event-fingerprint.js';
import {SourcePlanCache} from './source-plan-cache.js';
import {GoogleRequestError} from './google-request-error.js';
import {isRateLimit} from './google-rate-limit.js';
import {FolderWatchManager,type WatchAdapters} from './folder-watch.js';
import {GoogleSourceReader,googleSourcePlan,validateSourceGraph,googleOrigin,reconcileGoogleMasters,safeGoogleSourcePlan} from './google-source.js';
import {Cron} from 'croner';
import type {Config} from './config.js';
import type {Source,Status,Plan} from '../shared/contracts.js';
import {GoogleClient,CalendarListPermissionError,syncPlan,type GooglePort,type RemoteEvent,type SyncProgress} from './google.js';
import {loadSource,fetchSourceURL} from './sources.js';
import {AppError} from './errors.js';
interface Recovery {key:string;completed:Set<string>;uncertain:Set<string>;confirmedWrites:number;retryAt?:number}
export interface RunLog {event:'sync-start'|'sync-progress'|'sync-complete'|'sync-paused'|'sync-resume'|'sync-replanned';sourceIndex:number;kind:Source['kind'];fetched:number;changed:number;skipped:number;written:number;pending:number;confirmedEarlier:number;retryAt?:string;reason?:string;operation?:string;http?:number;quotaAttempt?:number;uncertainWrites?:number}
export class Runtime {
 readonly uploads=new Map<string,Uint8Array>();readonly statuses:Record<string,Status>={};sources:Source[];
 private queue:Promise<unknown>=Promise.resolve();private due=new Map<string,number>();private timer?:ReturnType<typeof setInterval>;private ticking=false;private automaticJobs=new Map<string,Promise<unknown>>();private watchAgain=new Set<string>();private closing=false;private now:()=>number;private automaticBlockedUntil=0;private permanentFailures=new Map<string,string>();private deferredWatch=new Set<string>();private recoveries=new Map<string,Recovery>();private logger:(event:RunLog)=>void;private rateRetryDue=new Map<string,number>();readonly folderWatch:FolderWatchManager;
 readonly google:GooglePort;private sourceReader=new GoogleSourceReader();private sourcePlans=new SourcePlanCache();
 constructor(readonly config:Config,options:{google?:GooglePort;urlLoader?:typeof fetchSourceURL;watchAdapters?:WatchAdapters;now?:()=>number;logger?:(event:RunLog)=>void}={}){this.logger=options.logger??(event=>console.info(JSON.stringify(event)));this.now=options.now??Date.now;this.sources=structuredClone(config.sources);this.google=options.google??new GoogleClient(config);this.urlLoader=options.urlLoader??fetchSourceURL;this.folderWatch=new FolderWatchManager(config.watchRoot,id=>this.requestAutomatic(id,'watch'),options.watchAdapters);}
 private urlLoader:typeof fetchSourceURL;
 invalidateGoogleSource(calendarId?:string){this.sourceReader.invalidate(calendarId);}
 private async googlePlan(source:Source,calendarId?:string,write=false){
  if(!this.google.readEvents)throw new AppError('Google-Quelle nicht verfügbar.');
  const snapshot=await this.sourceReader.snapshot(source.sourceCalendarId!,{readEvents:(calendar,params)=>this.google.readEvents!(calendar,params),...(this.google.getSourceEvent?{getSourceEvent:(calendar:string,id:string)=>this.google.getSourceEvent!(calendar,id)}:{})});
  let plan;try{plan=safeGoogleSourcePlan(snapshot,source,calendarId);}catch(error){this.sourceReader.invalidate(source.sourceCalendarId);throw error;}
  plan.sourceRevision=snapshot.revision;plan.stats.sourceFetched=snapshot.fetched;
  if(!calendarId)return {plan};if(!this.google.listOwnedMasters)throw new AppError('Google-Reconciliation nicht verfügbar; Abgleich gestoppt.');
  const detailed=write&&!!this.google.listManagedEvents,destination=detailed?await this.google.listManagedEvents!(calendarId,source.id,googleOrigin(source)):await this.google.listOwnedMasters(calendarId,source.id,googleOrigin(source));
  plan=reconcileGoogleMasters(plan,snapshot,source,calendarId,destination);plan.stats.targetFetched=destination.length;return {plan,targetState:detailed?destination:undefined};
 }

 async listCalendars(){if(!this.google.listCalendars)throw new AppError('Kalenderliste nicht verfügbar.');return this.google.listCalendars();}
 async validateCalendar(calendarId:string){const calendar=(await this.listCalendars()).find(c=>c.id===calendarId);if(!calendar||!['owner','writer'].includes(calendar.accessRole))throw new AppError('Zielkalender fehlt oder ist schreibgeschützt.');}
 async validateSourceCalendar(calendarId:string){const calendar=(await this.listCalendars()).find(c=>c.id===calendarId);if(!calendar||calendar.accessRole==='freeBusyReader')throw new AppError('Quellkalender fehlt oder hat keine Termin-Leseberechtigung.');}
 source(id:string){const source=this.sources.find(s=>s.id===id);if(!source)throw new AppError('Quelle nicht gefunden.');return source;}
 private signature(source:Source){return stableJSON([source,this.config.calendarId]);}
 private blocked(source:Source,now:number){const previous=this.permanentFailures.get(source.id);if(previous&&previous!==this.signature(source))this.permanentFailures.delete(source.id);return now<this.automaticBlockedUntil||this.permanentFailures.has(source.id);}
 private scheduleAfter(source:Source,now:number){const recovery=this.recoveries.get(source.id);const next=this.rateRetryDue.get(source.id)??recovery?.retryAt??(source.cron?new Cron(source.cron,{paused:true,timezone:source.cronTimezone}).nextRun(new Date(now))?.getTime()??Infinity:now+source.intervalSeconds*1000);this.due.set(source.id,Math.max(next,this.automaticBlockedUntil));}
 requestAutomatic(id:string,trigger:'watch'|'schedule',clock=this.now){
  if(this.closing)return Promise.resolve();const source=this.source(id);
  if(this.blocked(source,clock())){if(trigger==='watch')this.deferredWatch.add(id);return Promise.resolve();}
  const existing=this.automaticJobs.get(id);if(existing){if(trigger==='watch')this.watchAgain.add(id);return existing;}
  const signature=this.signature(source);const job=this.execute(id,this.config.writes,trigger);this.automaticJobs.set(id,job);
  void job.catch(()=>undefined).finally(()=>{this.automaticJobs.delete(id);const current=this.sources.find(s=>s.id===id);if(current){if(this.signature(current)===signature)this.scheduleAfter(current,clock());else this.due.delete(id);}if(this.watchAgain.delete(id)&&current?.enabled&&current.kind==='folder'&&current.watch)void this.requestAutomatic(id,'watch').catch(()=>undefined);});return job;
 }

 async execute(id:string,write=false,trigger?:'watch'|'schedule'){
  const operation=async()=>{
   const source=structuredClone(this.source(id)),calendarId=source.calendarId||this.config.calendarId,signature=this.signature(source);
   if(this.closing)throw new AppError('Verarbeitung beendet.');if(trigger&&this.blocked(source,this.now())){if(trigger==='watch')this.deferredWatch.add(id);return;}if(trigger&&(!source.enabled||source.kind==='upload'||trigger==='watch'&&(source.kind!=='folder'||!source.watch)))return;
   let plan:Plan|undefined,recovery:Recovery|undefined,progress:SyncProgress|undefined,confirmedEarlier=0,resuming=false,lastLogged=-1;
   const fields=()=>({fetched:plan?.stats.sourceFetched??plan?.stats.components??0,changed:progress?.changed??0,skipped:progress?.skipped??0,written:progress?.written??0,pending:progress?.pending??plan?.items.length??0,confirmedEarlier});
   const log=(event:RunLog['event'],extra:Partial<RunLog>={})=>{try{this.logger({event,sourceIndex:this.sources.findIndex(s=>s.id===id),kind:source.kind,...fields(),...extra});}catch{/* Observability cannot authorize or prevent calendar writes. */}};
   try{
    if(!trigger&&write){this.permanentFailures.delete(id);this.google.resetRateLimits?.([calendarId,...source.sourceCalendarId?[source.sourceCalendarId]:[]]);}
    if(write&&(!this.config.writes||this.config.demo||!calendarId||!this.config.clientId||!this.config.clientSecret||!this.config.refreshToken))throw new AppError('Google-Schreiben benötigt ausdrückliche Freigabe und vollständige OAuth-ENV.');
    validateSourceGraph(this.sources,this.config.calendarId);if(source.kind==='google')await this.validateSourceCalendar(source.sourceCalendarId!);if(write)await this.validateCalendar(calendarId);
    let targetState:RemoteEvent[]|undefined;
    if(source.kind==='google'){const loaded=await this.googlePlan(source,calendarId||undefined,write);plan=loaded.plan;targetState=loaded.targetState;}
    else{plan=await loadSource(source,this.config.watchRoot,this.uploads,this.urlLoader,calendarId||undefined,this.sourcePlans);if(write&&this.google.listManagedEvents){targetState=await this.google.listManagedEvents(calendarId,source.id);plan.stats.targetFetched=targetState.length;}}
    if(!write){this.statuses[id]={ok:true,at:new Date(this.now()).toISOString(),mode:'preview',stats:plan.stats};return plan;}
    const key=opaque('recovery-v2',signature,plan.sourceRevision??'',stableJSON(plan.items.map(i=>[i.key,!!i.parent,i.cancel,i.event?.extendedProperties.private.desiredHash??'',i.original??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))));
    const previous=this.recoveries.get(id);resuming=previous?.key===key;recovery=resuming?previous!:{key,completed:new Set(),uncertain:new Set(),confirmedWrites:0};confirmedEarlier=recovery.confirmedWrites;
    this.recoveries.set(id,recovery);log(resuming?'sync-resume':previous?'sync-replanned':'sync-start');
    const guard=()=>!this.closing&&this.signature(this.source(id))===signature;
    const destination=this.google.forCalendar?this.google.forCalendar(calendarId,guard):this.google;
    const result=await syncPlan(plan,{...source,calendarId},destination,{knownState:targetState,completed:recovery.completed,uncertain:recovery.uncertain,shouldContinue:guard,progress:(next,completedKey,uncertainKey)=>{
     progress=next;if(completedKey){if(recovery!.completed.size<20000)recovery!.completed.add(completedKey);recovery!.uncertain.delete(completedKey);}if(uncertainKey&&recovery!.uncertain.size<20000)recovery!.uncertain.add(uncertainKey);
     this.statuses[id]={ok:true,at:new Date(this.now()).toISOString(),mode:'sync',running:true,stats:plan!.stats,progress:{...fields(),resuming}};
     if(next.processed-lastLogged>=100){log('sync-progress');lastLogged=next.processed;}
    }});
    this.google.successfulRun?.([calendarId,...source.sourceCalendarId?[source.sourceCalendarId]:[]]);this.recoveries.delete(id);this.rateRetryDue.delete(id);this.permanentFailures.delete(id);
    this.statuses[id]={ok:true,at:new Date(this.now()).toISOString(),mode:'sync',stats:plan.stats,sync:result,progress:{...fields(),resuming}};log('sync-complete');return result;
   }catch(error){
    if(error instanceof AppError&&error.retryAt){this.automaticBlockedUntil=Math.max(this.automaticBlockedUntil,error.retryAt);this.rateRetryDue.set(id,error.retryAt);if(recovery)recovery.retryAt=error.retryAt;else this.due.set(id,error.retryAt);}
    if(recovery&&error instanceof AppError)recovery.confirmedWrites=confirmedEarlier+(error.confirmedWrites??progress?.written??0);
    if(error instanceof AppError&&error.retryExhausted||error instanceof CalendarListPermissionError||error instanceof GoogleRequestError&&([400,401].includes(error.status)||error.status===403&&!isRateLimit(error)))this.permanentFailures.set(id,signature);
    const message=error instanceof AppError?error.message:'Verarbeitung fehlgeschlagen; Quelle übersprungen.';
    this.statuses[id]={ok:false,at:new Date(this.now()).toISOString(),mode:write?'sync':'preview',error:message,...plan?{stats:plan.stats,progress:{...fields(),resuming}}:{},...error instanceof AppError&&error.retryAt?{retryAt:new Date(error.retryAt).toISOString()}:{},...this.permanentFailures.has(id)?{automaticPaused:true}:{}};
    if(write)log('sync-paused',{...error instanceof GoogleRequestError?{http:error.status,reason:error.reason,operation:error.operation}:{},...error instanceof AppError?{quotaAttempt:error.quotaAttempt,uncertainWrites:error.uncertainWrites,...error.retryAt?{retryAt:new Date(error.retryAt).toISOString()}:{}}:{}});
    throw error instanceof AppError?error:new AppError(message);
   }
  };const current=this.queue.then(operation);this.queue=current.catch(()=>undefined);return current;
 }

 resetDue(id:string){this.due.delete(id);this.permanentFailures.delete(id);this.recoveries.delete(id);this.rateRetryDue.delete(id);const source=this.source(id);this.google.resetRateLimits?.([source.calendarId||this.config.calendarId,...source.sourceCalendarId?[source.sourceCalendarId]:[]]);}
 async tick(now?:number){if(this.ticking)return;this.ticking=true;const at=now??this.now(),clock=now===undefined?this.now:()=>at;try{
  await this.folderWatch.tick(this.sources,at);
  for(const source of [...this.sources]){if(!source.enabled||source.kind==='upload')continue;if(this.blocked(source,at))continue;
   const watch=this.deferredWatch.delete(source.id)&&source.kind==='folder'&&source.watch;
   let deadline=this.due.get(source.id);if(deadline===undefined&&source.cron){deadline=new Cron(source.cron,{paused:true,timezone:source.cronTimezone}).nextRun(new Date(at))?.getTime()??Infinity;this.due.set(source.id,deadline);}
   if(!watch&&(deadline??0)>at)continue;
   try{await this.requestAutomatic(source.id,watch?'watch':'schedule',clock);}catch{/* Sanitized status is available through the API. */}
  }
 }finally{this.ticking=false;}}

 start(){if(!this.timer){this.timer=setInterval(()=>{void this.folderWatch.tick(this.sources).catch(()=>undefined);void this.tick();},1000);void this.tick();}}
 async close(){this.closing=true;this.watchAgain.clear();this.deferredWatch.clear();this.google.close?.();if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.folderWatch.close();await this.queue;this.uploads.clear();this.sourcePlans.clear();this.recoveries.clear();this.rateRetryDue.clear();this.sourceReader.invalidate();}
}
