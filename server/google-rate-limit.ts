import {AppError} from './errors.js';
import {GoogleRequestError,googleRequestError} from './google-request-error.js';
export class GoogleWriteUncertainError extends AppError {uncertainWrites=1;constructor(){super('Google-Schreibantwort unbestätigt; kein automatischer Request-Retry. Nächster freigegebener Lauf liest das Ziel erneut.');}}
export class GoogleCooldownError extends AppError {constructor(readonly retryAt:number){super('Google-Anfragen wegen Rate-Limit pausiert bis '+new Date(retryAt).toISOString()+'.');}}
export class GoogleRetryExhaustedError extends AppError {retryExhausted=true;constructor(){super('Google-Rate-Limit wiederholt erreicht; automatische Wiederaufnahme nach sechs Fehlversuchen pausiert. Einstellungen prüfen oder später ausdrücklich erneut synchronisieren.');}}
export function isRateLimit(error:GoogleRequestError){return error.status===403&&['rateLimitExceeded','userRateLimitExceeded'].includes(error.reason)||error.status===429&&['rateLimitExceeded','userRateLimitExceeded','unknown'].includes(error.reason);}
export interface RateOptions {now?:()=>number;random?:()=>number;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;requestIntervalMs?:number;writeIntervalMs?:number;maxWaitMs?:number;firstCooldownMs?:number;maxCooldownMs?:number;maxQuotaFailures?:number}
function sleep(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new AppError('Google-Verarbeitung beendet.'));return;}const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new AppError('Google-Verarbeitung beendet.'));}signal.addEventListener('abort',abort,{once:true});});}
export class GoogleRequestGate {
 private queue:Promise<unknown>=Promise.resolve();private controller=new AbortController();private lastRequest=-Infinity;private lastWrite=new Map<string,number>();private quota=new Map<string,{failures:number;until:number}>();
 readonly now:()=>number;private random:()=>number;private sleep:(ms:number,signal:AbortSignal)=>Promise<void>;
 constructor(private fetcher:typeof fetch,private options:RateOptions={}){this.now=options.now??Date.now;this.random=options.random??Math.random;this.sleep=options.sleep??sleep;}
 close(){this.controller.abort();}
 successfulRun(calendars:string[]){for(const calendar of [...calendars.map(encodeURIComponent),'@account'])this.quota.delete(calendar);}
 resetFailures(_calendars:string[]){for(const state of this.quota.values())state.failures=0;}
 fetch(url:URL,options:RequestInit,guard?:()=>boolean){const job=this.queue.then(()=>this.perform(url,options,guard));this.queue=job.catch(()=>undefined);return job;}
 private async perform(url:URL,options:RequestInit,guard?:()=>boolean):Promise<Response>{
  const method=options.method??'GET',write=method!=='GET',path=url.pathname.includes('/calendarList')?'@calendarList':url.pathname.slice(url.pathname.indexOf('/events')+7),calendar=url.pathname.split('/calendars/')[1]?.split('/events')[0]??'@account';
  const signal=options.signal?AbortSignal.any([this.controller.signal,options.signal]):this.controller.signal;
  if(signal.aborted)throw new AppError('Google-Verarbeitung beendet.');
  const blockedUntil=Math.max(0,...[...this.quota.values()].map(q=>q.until));if(blockedUntil>this.now())throw new GoogleCooldownError(blockedUntil);
  if([...this.quota.values()].some(q=>q.failures>=(this.options.maxQuotaFailures??6)))throw new GoogleRetryExhaustedError();
  const wait=Math.max(0,this.lastRequest+(this.options.requestIntervalMs??250)-this.now(),write?(this.lastWrite.get(calendar)??-Infinity)+(this.options.writeIntervalMs??1000)-this.now():0);
  if(wait>(this.options.maxWaitMs??60000))throw new AppError('Google-Request-Zeitbudget erreicht.');
  if(wait>0)await this.sleep(wait,signal);if(signal.aborted)throw new AppError('Google-Verarbeitung beendet.');
  if(guard&&!guard())throw new AppError('Quellkonfiguration während des Laufs geändert; vor nächstem Request gestoppt.');
  this.lastRequest=this.now();if(write){this.lastWrite.delete(calendar);this.lastWrite.set(calendar,this.now());if(this.lastWrite.size>64)this.lastWrite.delete(this.lastWrite.keys().next().value!);}
  let response:Response;try{response=await this.fetcher(url,{...options,signal});}catch{if(write)throw new GoogleWriteUncertainError();throw new AppError(signal.aborted?'Google-Verarbeitung beendet.':'Google-Verbindung fehlgeschlagen; kein Request-Retry.');}
  if(response.status!==403&&response.status!==429)return response;
  const error=await googleRequestError(response,method,path,this.now());if(!isRateLimit(error))throw error;
  const failures=(this.quota.get(calendar)?.failures??0)+1;
  const delay=Math.min((this.options.firstCooldownMs??600000)*2**Math.min(failures-1,20),this.options.maxCooldownMs??21600000)+Math.floor(Math.max(0,Math.min(1,this.random()))*30000);
  const until=Math.max(error.retryAfterUntil??0,this.now()+delay);this.quota.set(calendar,{failures,until});if(this.quota.size>64)this.quota.delete(this.quota.keys().next().value!);
  error.retryAt=until;error.quotaAttempt=failures;error.retryExhausted=failures>=(this.options.maxQuotaFailures??6);error.message+=' Rate-Limit-Pause bis '+new Date(until).toISOString()+'.';if(error.retryExhausted)error.message+=' Automatik nach sechs Fehlversuchen pausiert.';throw error;
 }
}
