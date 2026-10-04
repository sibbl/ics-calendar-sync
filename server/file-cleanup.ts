import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AppError} from './errors.js';
import {DataStore,type SourceState,type InputFile,type CleanupRecord} from './data-store.js';
import type {Source} from '../shared/contracts.js';
const inside=(root:string,file:string)=>file===root||file.startsWith(root+path.sep);
async function inspect(file:string){let h:Awaited<ReturnType<typeof fs.open>>|undefined;try{h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await h.stat({bigint:true});if(!before.isFile()||before.size>8388608n)throw Error();const data=await h.readFile(),after=await h.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error();return {hash:createHash('sha256').update(data).digest('hex'),dev:String(after.dev),ino:String(after.ino),size:String(after.size),mtimeNs:String(after.mtimeNs),ctimeNs:String(after.ctimeNs)};}finally{await h?.close();}}
function same(a:Awaited<ReturnType<typeof inspect>>,b:InputFile,claimed=false){return a.hash===b.hash&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&(claimed||a.ctimeNs===b.ctimeNs);}
async function exists(p:string){try{await fs.lstat(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
// Cleanup is invoked only after all target operations were confirmed. Rename first
// into a protected same-filesystem claim; verify the exact imported inode/bytes
// again. A racing new file is retained/restored without overwriting a producer.
export async function cleanupFiles(root:string,source:Source,store:DataStore,state:SourceState,signature:string,files?:InputFile[],hooks:{beforeClaim?():Promise<void>;shouldContinue?():boolean}={}){
 const check=()=>{if(hooks.shouldContinue&&!hooks.shouldContinue())throw new AppError('Konfiguration geändert; Dateibereinigung gestoppt.');};check();const counts={filesArchived:0,filesDeleted:0,filesRetained:0};if(!source.fileHandling||source.fileHandling==='keep')return counts;
 if(!source.immutableFilesConfirmed)throw new AppError('Veröffentlichte Dateien müssen unveränderlich sein.');
 const realRoot=await fs.realpath(root),folder=await fs.realpath(path.resolve(realRoot,source.location));if(!inside(realRoot,folder))throw new AppError('Bereinigungspfad außerhalb Quellordner.');
 const pending=path.join(folder,'.ics-sync-pending',source.id),archive=path.join(folder,'.ics-sync-archive',source.id);
 for(const p of [path.dirname(pending),pending,path.dirname(archive),archive]){await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw new AppError('Geschützter Bereinigungsordner ungültig.');}
 if(files){if(state.cleanup&&state.cleanup.signature!==signature&&state.cleanup.records.some(r=>r.phase!=='done'))throw new AppError('Offene Bereinigung bei geänderter Konfiguration; Dateien geschützt.');const retained:CleanupRecord[]=[];for(const r of state.cleanup?.records??[]){if(r.phase==='retained'&&await exists(path.join(pending,r.stage)))retained.push(r);}state.cleanup={signature,records:[...retained,...files.map(file=>({file,stage:createHash('sha256').update(JSON.stringify(file)).digest('hex')+'.pending',mode:source.fileHandling as 'archive'|'delete',phase:'intent' as const}))]};if(state.cleanup.records.length>100)throw new AppError('Offene Bereinigungsdateien müssen geprüft werden.');await store.write(state);}
 if(!state.cleanup||state.cleanup.signature!==signature)return counts;
 for(const record of state.cleanup.records){if(record.phase==='done')continue;if(record.phase==='retained'){counts.filesRetained++;continue;}
  if(!/^[a-f0-9]{64}\.pending$/.test(record.stage)||!record.file||! /^[a-f0-9]{64}$/.test(record.file.hash)||!['archive','delete'].includes(record.mode)||record.mode!==source.fileHandling)throw new AppError('Bereinigungsjournal ungültig; nichts gelöscht.');
  const original=path.resolve(realRoot,record.file.relativePath),stage=path.join(pending,record.stage);if(!inside(folder,original)||path.dirname(original)!==folder||!original.toLowerCase().endsWith('.ics'))throw new AppError('Journaldatei außerhalb ausgewähltem Ordner.');
  try{
   if(record.phase==='intent'&&!await exists(stage)){const info=await inspect(original);if(!same(info,record.file)){record.phase='retained';counts.filesRetained++;await store.write(state);continue;}check();await hooks.beforeClaim?.();check();await fs.rename(original,stage);}
   record.phase='claimed';await store.write(state);
   if(!same(await inspect(stage),record.file,true)){if(!await exists(original))await fs.link(stage,original).then(()=>fs.unlink(stage)).catch(()=>undefined);record.phase='retained';counts.filesRetained++;await store.write(state);continue;}
   check();if(record.mode==='archive'){const destination=path.join(archive,record.stage.slice(0,-8)+'.ics');if(await exists(destination)){if(!same(await inspect(destination),record.file,true))throw Error();await fs.unlink(stage);}else await fs.rename(stage,destination);record.archive=path.relative(realRoot,destination);counts.filesArchived++;}
   else{await fs.unlink(stage);counts.filesDeleted++;}
   record.phase='done';await store.write(state);
  }catch(e){if(record.phase==='claimed'&&!await exists(stage)){if(record.mode==='delete')record.phase='done';else{const destination=path.join(archive,record.stage.slice(0,-8)+'.ics');if(await exists(destination)&&same(await inspect(destination),record.file,true))record.phase='done';}await store.write(state);}else{if(hooks.shouldContinue&&!hooks.shouldContinue()){if(await exists(stage)&&!await exists(original))await fs.link(stage,original).then(()=>fs.unlink(stage)).catch(()=>undefined);record.phase='retained';}counts.filesRetained++;await store.write(state);}}
 }
 return counts;
}
