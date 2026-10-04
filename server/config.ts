import path from 'node:path';
import {validatedWindow} from './snapshot-preview.js';
import {compileTextRules} from './text-rules.js';
import { readFileSync } from 'node:fs';
import { Cron } from 'croner';
import { sourceSchema, type Source } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { FileAuthStore } from './auth-store.js';
export interface Config {adminToken:string;clientId:string;clientSecret:string;refreshToken:string;calendarId:string;writes:boolean;watchRoot:string;sources:Source[];demo:boolean;port:number;host:string;authFile?:string;dataDir?:string}
export function configuredSources(raw:string):Source[]{try{const sources=sourceSchema.array().max(32).parse(JSON.parse(raw));if(new Set(sources.map(s=>s.id)).size!==sources.length)throw Error();for(const source of sources){compileTextRules(source.rules);if(source.snapshotScope)validatedWindow(source.snapshotScope);new Intl.DateTimeFormat('en',{timeZone:source.rules.floatingTimezone});new Intl.DateTimeFormat('en',{timeZone:source.cronTimezone});if(source.cron)new Cron(source.cron,{paused:true,timezone:source.cronTimezone}).stop();}return sources;}catch{throw new AppError('SOURCES_JSON ungültig: eindeutige UUIDs, Regeln und Zeitplan prüfen.');}}
export function configFromEnv(env:NodeJS.ProcessEnv=process.env):Config{
 function secret(name:string){const value=env[name]??'',file=env[name+'_FILE']??'';if(value&&file)throw new AppError('ENV und _FILE dürfen nicht gleichzeitig gesetzt sein.');try{return file?readFileSync(file,'utf8').trim():value;}catch{throw new AppError('Secret-Datei ist nicht lesbar.');}}
 const authFile=env.AUTH_FILE??'';const dataDir=env.DATA_DIR;
 if(dataDir){const data=path.resolve(dataDir),inputs=path.resolve(env.WATCH_ROOT??'/sources'),auth=authFile?path.dirname(path.resolve(authFile)):undefined;const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);if(overlaps(data,inputs)||auth&&overlaps(data,auth))throw new AppError('DATA_DIR muss von Quellen und Auth-Speicher getrennt sein.');}

 if(authFile&&['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'].some(name=>env[name]||env[name+'_FILE']))throw new AppError('AUTH_FILE nicht mit OAuth-ENV/_FILE mischen.');
 const auth=authFile?new FileAuthStore(authFile).read():{clientId:secret('GOOGLE_CLIENT_ID'),clientSecret:secret('GOOGLE_CLIENT_SECRET'),refreshToken:secret('GOOGLE_REFRESH_TOKEN')};
 return {adminToken:secret('APP_ADMIN_TOKEN'),...auth,...authFile?{authFile}:{},...env.DATA_DIR?{dataDir:env.DATA_DIR}:{},calendarId:env.GOOGLE_CALENDAR_ID??'',writes:env.ENABLE_GOOGLE_WRITES==='true',watchRoot:env.WATCH_ROOT??'/sources',sources:configuredSources(env.SOURCES_JSON??'[]'),demo:false,port:Number(env.PORT??8080),host:env.HOST??'127.0.0.1'};
}
