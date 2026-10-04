import {AppError} from './errors.js';
const allowedReasons=new Set(['badRequest','invalid','invalidParameter','required','forbidden','rateLimitExceeded','userRateLimitExceeded','quotaExceeded','dailyLimitExceeded','notFound','conditionNotMet','duplicate','backendError','internalError','authError']);
export class GoogleRequestError extends AppError {
 completedWrites?:number;retryAfterUntil?:number;
 constructor(readonly status:number,readonly operation:string,readonly method:string,readonly reason:string,readonly category:string){super(`Google ${operation} (${method}) fehlgeschlagen (HTTP ${status}; ${reason}; ${category}); Lauf gestoppt.`);}
}
export async function googleRequestError(response:Response,method:string,path:string,now=Date.now()){
 let data:any;
 // Never keep raw Google bodies/messages; cap the error read independently.
 if(response.body){const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){data=undefined;break;}chunks.push(value);}if(size<=16384){const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}try{data=JSON.parse(new TextDecoder().decode(bytes));}catch{}}}catch{}finally{await reader.cancel().catch(()=>undefined);}}
 const error=data?.error,message=typeof error?.message==='string'?error.message:'';
 const reason=Array.isArray(error?.errors)?error.errors.map((e:any)=>e?.reason).find((r:unknown)=>typeof r==='string'&&allowedReasons.has(r))??'unknown':'unknown';
 const category=/originalStart/i.test(message)?'original_start':/recurr/i.test(message)?'recurrence':/cancelled|canceled|deleted/i.test(message)?'cancelled_event':/start.*end|end.*start/i.test(message)?'event_time':/quota|rate.*limit/i.test(message)?'quota':/^Invalid Value$/i.test(message)?'invalid_value':'unspecified';
 const operation=path==='@calendarList'?'calendarList.list':path.endsWith('/instances')?'events.instances':method==='GET'?(path?'events.get':'events.list'):method==='POST'?'events.insert':method==='PATCH'?'events.patch':'events.update';
 const result=new GoogleRequestError(response.status,operation,method,reason,category);
 const retryAfter=response.headers.get('Retry-After');if(retryAfter){const seconds=/^\d+(?:\.\d+)?$/.test(retryAfter.trim())?Number(retryAfter.trim()):NaN,until=Number.isFinite(seconds)?now+seconds*1000:Date.parse(retryAfter);if(Number.isFinite(until)&&until>=now&&until<=8640000000000000)result.retryAfterUntil=until;}return result;
}
