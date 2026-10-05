import {validateSourceGraph} from './google-source.js';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {configuredSources,type Config} from './config.js';
import {CalendarListPermissionError,CALENDAR_LIST_SCOPE} from './google.js';
import {exportConfiguration} from './env-export.js';
import {Runtime} from './runtime.js';
import {AppError,MAX_BYTES} from './errors.js';
import {parseCalendar} from './calendar.js';
import type {AppState} from '../shared/contracts.js';
export function createApp(config:Config,runtime=new Runtime(config)){
 const app=new Hono();
 app.use('*',async(c,next)=>{await next();c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");});
 app.use('/api/*',bodyLimit({maxSize:MAX_BYTES+65536,onError:c=>c.json({error:'Anfrage zu groß.'},413)}));
 app.use('/api/*',async(c,next)=>{if(!config.adminToken)return c.json({error:'APP_ADMIN_TOKEN fehlt; API ist gesperrt.'},503);const provided=c.req.header('Authorization')??'';const match=/^Bearer (.+)$/.exec(provided);const supplied=Buffer.from(match?.[1]??''),expected=Buffer.from(config.adminToken);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return c.json({error:'Admin-Token erforderlich.'},401);await next();});
 app.onError((error,c)=>error instanceof CalendarListPermissionError?c.json({error:error.message,requiredScope:CALENDAR_LIST_SCOPE,code:'calendar_list_permission_required'},403):c.json({error:error instanceof AppError?error.message:'Konfiguration oder Verarbeitung ungültig; keine Quelldetails ausgegeben.'},400));
 app.get('/healthz',c=>c.json({status:'ok'}));
 app.get('/api/state',c=>c.json({sources:runtime.sources.map(s=>({...s,location:''})),statuses:runtime.statuses,watchStatuses:runtime.folderWatch.statuses,writesEnabled:config.writes&&!config.demo,oauthConfigured:!!(config.clientId&&config.clientSecret&&config.refreshToken),calendarConfigured:!!config.calendarId,defaultCalendarId:config.calendarId,ephemeral:true,demo:config.demo} satisfies AppState));
 app.get('/api/calendars',async c=>c.json({calendars:await runtime.listCalendars()}));
 app.put('/api/default-calendar',async c=>{const input=await c.req.json();if(typeof input.calendarId!=='string'||input.calendarId.length>1024||/[\x00-\x1f\x7f]/.test(input.calendarId))throw new AppError('Zielkalender ungültig.');if(input.calendarId)await runtime.validateCalendar(input.calendarId);validateSourceGraph(runtime.sources,input.calendarId);config.calendarId=input.calendarId;return c.json({ok:true,ephemeral:true});});
 app.post('/api/sources',async c=>{if(runtime.sources.length>=32)throw new AppError('Maximal 32 Quellen.');const input=await c.req.json();const source=configuredSources(JSON.stringify([{...input,id:input.id??randomUUID()}]))[0]!;if(runtime.sources.some(s=>s.id===source.id))throw new AppError('Quell-ID existiert bereits.');if(source.calendarId)await runtime.validateCalendar(source.calendarId);if(source.kind==='google')await runtime.validateSourceCalendar(source.sourceCalendarId!);validateSourceGraph([...runtime.sources,source],config.calendarId);runtime.sources.push(source);return c.json({...source,location:''},201);});
 app.put('/api/sources/:id',async c=>{const current=runtime.source(c.req.param('id')),input=await c.req.json();const source=configuredSources(JSON.stringify([{...input,id:current.id,location:input.location||current.location}]))[0]!;if(source.kind!==current.kind)throw new AppError('Quelltypwechsel benötigt eine neue Quelle.');if(source.calendarId&&source.calendarId!==current.calendarId)await runtime.validateCalendar(source.calendarId);if(source.kind==='google')await runtime.validateSourceCalendar(source.sourceCalendarId!);validateSourceGraph(runtime.sources.map(s=>s.id===current.id?source:s),config.calendarId);if(current.sourceCalendarId!==source.sourceCalendarId&&current.sourceCalendarId)runtime.invalidateGoogleSource(current.sourceCalendarId);Object.assign(current,source);delete runtime.statuses[current.id];runtime.resetDue(current.id);return c.json({ok:true,ephemeral:true});});
 app.post('/api/sources/:id/upload',async c=>{const source=runtime.source(c.req.param('id'));if(source.kind!=='upload')throw new AppError('Keine Upload-Quelle.');const data=await c.req.formData(),file=data.get('file');if(!(file instanceof File)||file.size>MAX_BYTES)throw new AppError('ICS-Datei fehlt oder ist zu groß.');const bytes=new Uint8Array(await file.arrayBuffer());parseCalendar(bytes,source.id,source.rules);runtime.uploads.set(source.id,bytes);return c.json({ok:true,ephemeral:true});});
 app.post('/api/sources/:id/preview',async c=>c.json(await runtime.execute(c.req.param('id'))));
 app.post('/api/sources/:id/sync',async c=>{const input=await c.req.json().catch(()=>({}));if(input.snapshotApproval!==undefined&&typeof input.snapshotApproval!=='string')throw new AppError('Snapshot-Bestätigung ungültig.');return c.json(await runtime.execute(c.req.param('id'),true,undefined,input.snapshotApproval?{token:input.snapshotApproval,emptyConfirmed:input.emptyConfirmed===true,newerConfirmed:input.newerConfirmed===true}:undefined));});
 app.get('/api/env-export',c=>c.json(exportConfiguration(runtime.sources,config.calendarId)));
 return {app,runtime};
}
