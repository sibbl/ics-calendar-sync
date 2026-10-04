import {constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync, writeFileSync, fsyncSync, renameSync, unlinkSync} from 'node:fs';
import {dirname, resolve, isAbsolute, basename, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError} from './errors.js';
export interface AuthCredentials {clientId:string;clientSecret:string;refreshToken:string}
function valid(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\r\n\0]/.test(value);}
export class FileAuthStore {
 readonly filename:string;
 constructor(filename:string,private atomicRename:typeof renameSync=renameSync){if(!isAbsolute(filename))throw new AppError('AUTH_FILE benötigt einen absoluten Pfad.');this.filename=resolve(filename);}
 private directory(){const parent=dirname(this.filename),s=lstatSync(parent);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(parent)!==parent||(s.mode&0o777)!==0o700||s.uid!==process.getuid?.())throw Error();return parent;}
 read():AuthCredentials{
  let fd:number|undefined;
  try{
   this.directory();fd=openSync(this.filename,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);
   if(!s.isFile()||(s.mode&0o777)!==0o600||s.uid!==process.getuid?.()||s.size>65536)throw Error();
   const value=JSON.parse(readFileSync(fd,'utf8')) as Record<string,unknown>;
   if(value.version!==1||!valid(value.clientId)||!valid(value.clientSecret)||!valid(value.refreshToken)||Object.keys(value).some(k=>!['version','clientId','clientSecret','refreshToken'].includes(k)))throw Error();
   return {clientId:value.clientId,clientSecret:value.clientSecret,refreshToken:value.refreshToken};
  }catch{throw new AppError('OAuth-Dateispeicher nicht lesbar oder nicht geschützt (Datei 0600, Ordner 0700, eigener Benutzer).');}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 create(credentials:AuthCredentials){
  let fd:number|undefined,created=false;
  try{this.directory();if(!Object.values(credentials).every(valid))throw Error();fd=openSync(this.filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;writeFileSync(fd,JSON.stringify({version:1,...credentials})+'\n');fsyncSync(fd);}
  catch{if(created){try{unlinkSync(this.filename);}catch{/* No values logged. */}}throw new AppError('Neue OAuth-Datei konnte nicht geschützt angelegt werden; vorhandene Dateien bleiben erhalten.');}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 private commit(snapshot:AuthCredentials,replacement:AuthCredentials){
  let temporary:string|undefined,fd:number|undefined;
  try{
   if(!Object.values(replacement).every(valid))throw Error();const current=this.read();
   if(current.clientId!==snapshot.clientId||current.clientSecret!==snapshot.clientSecret||current.refreshToken!==snapshot.refreshToken)throw Error();
   if(JSON.stringify(replacement)===JSON.stringify(snapshot))return;
   temporary=join(this.directory(),'.'+basename(this.filename)+'.tmp-'+randomUUID());
   fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   writeFileSync(fd,JSON.stringify({version:1,...replacement})+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
   const unchanged=this.read();if(JSON.stringify(unchanged)!==JSON.stringify(snapshot))throw Error();
   this.atomicRename(temporary,this.filename);temporary=undefined;
   const directoryFd=openSync(dirname(this.filename),constants.O_RDONLY);try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
  }catch{throw new AppError('OAuth-Tokenwechsel konnte nicht sicher gespeichert werden; Kalenderanfrage gestoppt. Dateirechte/Speicher prüfen.');}
  finally{if(fd!==undefined)closeSync(fd);if(temporary){try{unlinkSync(temporary);}catch{/* No values logged. */}}}
 }
 async replace(credentials:AuthCredentials,expected?:AuthCredentials){return this.withLock(async current=>{if(expected&&JSON.stringify(current)!==JSON.stringify(expected))throw new AppError('OAuth-Datei wurde während der Anmeldung geändert; keine Übernahme.');this.commit(current,credentials);});}
 async withLock<T>(operation:(credentials:AuthCredentials,persist:(refreshToken:string)=>void)=>Promise<T>):Promise<T>{
  let fd:number|undefined,lock:string|undefined;
  try{
   this.directory();lock=join(dirname(this.filename),'.'+basename(this.filename)+'.lock');
   try{fd=openSync(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch{lock=undefined;throw Error();}
  }catch{throw new AppError('OAuth-Dateispeicher ist gesperrt oder nicht schreibbar; kein Tokenabruf ausgeführt.');}
  try{const snapshot=this.read();return await operation(snapshot,next=>this.commit(snapshot,{...snapshot,refreshToken:next}));}
  finally{if(fd!==undefined)closeSync(fd);if(lock){try{unlinkSync(lock);}catch{/* A stale empty lock blocks further refreshes safely. */}}}
 }
}
