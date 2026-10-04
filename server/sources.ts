import {createHash} from 'node:crypto';
import type {SourcePlanCache} from './source-plan-cache.js';
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';
import type {Source,Plan,Item} from '../shared/contracts.js';
import {parseCalendar} from './calendar.js';
import {AppError,MAX_BYTES} from './errors.js';
export function isPublicAddress(address:string):boolean{
 if(isIP(address)===4){const [a,b]=address.split('.').map(Number) as [number,number];return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||address.startsWith('192.0.0.')||address.startsWith('192.0.2.')||address.startsWith('198.51.100.')||address.startsWith('203.0.113.'));}
 return isIP(address)===6&&/^[23]/i.test(address)&&!address.toLowerCase().startsWith('2001:db8:');
}
export async function resolvePublicHost(raw:string,resolver=lookup){let url:URL;try{url=new URL(raw);}catch{throw new AppError('Quell-URL ungültig.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new AppError('Nur HTTP(S)-URLs ohne eingebettete Zugangsdaten.');
 try{const addresses=await resolver(url.hostname.replace(/^\[|\]$/g,''),{all:true});if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new AppError('Private, lokale oder reservierte URL-Ziele sind nicht freigegeben.');return {url,address:addresses[0]!};}catch(error){if(error instanceof AppError)throw error;throw new AppError('URL-Ziel nicht erreichbar.');}}
export async function fetchSourceURL(raw:string):Promise<Uint8Array>{
 let location=raw;
 for(let redirect=0;redirect<4;redirect++){
  const {url,address}=await resolvePublicHost(location);
  const result=await new Promise<{data?:Buffer;redirect?:string}>((resolve,reject)=>{
   const transport=url.protocol==='https:'?https:http;
   // Pin the DNS result while retaining the original hostname for Host/SNI/TLS.
   const request=transport.get(url,{lookup:((_host:unknown,options:unknown,callback:Function)=>{
    if((options as {all?:boolean})?.all)callback(null,[address]);else callback(null,address.address,address.family);
   }) as typeof import('node:dns').lookup,timeout:30000,signal:AbortSignal.timeout(30000)},response=>{
    if([301,302,303,307,308].includes(response.statusCode??0)){response.resume();if(!response.headers.location)return reject(new AppError('URL-Weiterleitung ungültig.'));return resolve({redirect:new URL(response.headers.location,url).href});}
    if(response.statusCode!==200){response.resume();return reject(new AppError('URL-Abruf fehlgeschlagen.'));}
    let size=0;const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BYTES){response.destroy();reject(new AppError('URL-Quelle größer als 10 MiB.'));}else chunks.push(chunk);});response.on('end',()=>resolve({data:Buffer.concat(chunks)}));response.on('error',()=>reject(new AppError('URL-Abruf fehlgeschlagen.')));
   });request.on('timeout',()=>request.destroy(new Error('timeout')));request.on('error',()=>reject(new AppError('URL-Abruf fehlgeschlagen.')));
  });if(result.data)return result.data;location=result.redirect!;
 }throw new AppError('Zu viele URL-Weiterleitungen.');
}
function inside(root:string,file:string){const relative=path.relative(root,file);return relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
export async function folderFingerprint(root:string,location:string){
 const watchRoot=await fs.realpath(root),requested=path.resolve(watchRoot,location);if(!inside(watchRoot,requested))throw new AppError('Quellordner liegt außerhalb von WATCH_ROOT.');
 const real=await fs.realpath(requested);if(!inside(watchRoot,real))throw new AppError('Quellordner verlässt WATCH_ROOT.');const dir=await fs.stat(real,{bigint:true});if(!dir.isDirectory())throw new AppError('Quellordner ungültig.');
 const names=(await fs.readdir(real)).filter(n=>n.toLowerCase().endsWith('.ics')).sort();if(names.length>100)throw new AppError('Zu viele ICS-Dateien.');
 const metadata:string[][]=[];for(const name of names){const file=await fs.realpath(path.join(real,name));if(!inside(watchRoot,file))throw new AppError('Quelldatei verlässt WATCH_ROOT.');const info=await fs.stat(file,{bigint:true});if(!info.isFile()||info.size>BigInt(MAX_BYTES))throw new AppError('Dateiquelle ungültig oder zu groß.');metadata.push([name,file,String(info.dev),String(info.ino),String(info.size),String(info.mtimeNs),String(info.ctimeNs)]);}
 return {path:real,identity:String(dir.dev)+':'+String(dir.ino),signature:JSON.stringify([String(dir.dev),String(dir.ino),String(dir.mtimeNs),metadata])};
}
async function readFile(root:string,file:string,manifest?:import('./data-store.js').InputFile[],destructive=false){let handle:Awaited<ReturnType<typeof fs.open>>|undefined;try{
 if(destructive&&(await fs.lstat(file)).isSymbolicLink())throw new AppError('Bereinigung von Symlink-Dateien ist gesperrt.');const resolved=await fs.realpath(file);if(!inside(root,resolved))throw new AppError('Quellpfad oder Symlink verlässt WATCH_ROOT.');handle=await fs.open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await handle.stat({bigint:true});if(!before.isFile()||before.size>BigInt(MAX_BYTES))throw new AppError('Dateiquelle ungültig oder zu groß.');const data=await handle.readFile();const after=await handle.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||data.length>MAX_BYTES)throw new AppError('Quelldatei während des Lesens verändert.');manifest?.push({relativePath:path.relative(root,resolved),hash:createHash('sha256').update(data).digest('hex'),dev:String(after.dev),ino:String(after.ino),size:String(after.size),mtimeNs:String(after.mtimeNs),ctimeNs:String(after.ctimeNs)});return data;
 }catch(error){if(error instanceof AppError)throw error;throw new AppError('Dateiquelle nicht lesbar.');}finally{await handle?.close();}}
export async function loadSource(source:Source,root:string,uploads:Map<string,Uint8Array>,urlLoader=fetchSourceURL,calendarId=source.calendarId,cache?:SourcePlanCache):Promise<Plan>{
 try{
  let inputs:Uint8Array[];const inputFiles:import('./data-store.js').InputFile[]=[];const destructive=source.fileHandling!==undefined&&source.fileHandling!=='keep';
  if(source.kind==='upload'){const data=uploads.get(source.id);if(!data)throw new AppError('Noch kein Upload für diese Quelle.');inputs=[data];}
  else if(source.kind==='url')inputs=[await urlLoader(source.location)];
  else{const watchRoot=await fs.realpath(root),location=path.resolve(watchRoot,source.location);if(!inside(watchRoot,location))throw new AppError('Quellpfad liegt außerhalb von WATCH_ROOT.');if(source.kind==='file')inputs=[await readFile(watchRoot,location,inputFiles,destructive)];else{
   const initial=await folderFingerprint(watchRoot,source.location);const real=initial.path;if(!inside(watchRoot,real))throw new AppError('Quellordner verlässt WATCH_ROOT.');const names=(await fs.readdir(real)).filter(n=>n.toLowerCase().endsWith('.ics')&&(source.folderMode!=='snapshot'||n===source.snapshotFile)).sort();if(!names.length&&destructive)return {inputMissing:true,sourceRevision:createHash('sha256').update('no-input').digest('hex'),items:[],stats:{files:0,upserts:0,explicitCancellations:0},warnings:['Warten auf nächsten vollständigen Export; bestehende Termine bleiben erhalten.']};if(!names.length||names.length>100)throw new AppError('Quellordner enthält keine oder zu viele ICS-Dateien.');inputs=[];for(const name of names)inputs.push(await readFile(watchRoot,path.join(real,name),inputFiles,destructive));if((await folderFingerprint(watchRoot,source.location)).signature!==initial.signature)throw new AppError('Quellordner während des Lesens verändert; vollständig übersprungen.');
  }}
  const plans=inputs.map(data=>cache?cache.parse(data,source,calendarId):parseCalendar(data,source.id,source.rules,calendarId)),items=new Map<string,Item>();for(const plan of plans)for(const item of plan.items){const previous=items.get(item.key);if(previous&&JSON.stringify(previous)!==JSON.stringify(item))throw new AppError('Widersprüchliche UID in mehreren Quelldateien.');items.set(item.key,item);}
  const revision=createHash('sha256');for(const input of inputs)revision.update(String(input.length)+'\0').update(input);return {inputFiles,sourceRevision:revision.digest('hex'),items:[...items.values()],stats:{files:plans.length,components:plans.reduce((n,p)=>n+(p.stats.components??0),0),sourceFetched:plans.reduce((n,p)=>n+(p.stats.components??0),0),upserts:[...items.values()].filter(i=>!i.cancel).length,explicitCancellations:[...items.values()].filter(i=>i.cancel).length},warnings:[...new Set(plans.flatMap(p=>p.warnings))]};
 }catch(error){if(error instanceof AppError)throw error;throw new AppError('Quelle nicht lesbar; vollständig übersprungen.');}
}
