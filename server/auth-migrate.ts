import{constants,openSync,fstatSync,readFileSync,closeSync}from'node:fs';
import{createInterface}from'node:readline/promises';
import{dirname,resolve}from'node:path';
import{pathToFileURL}from'node:url';
import{FileAuthStore,type AuthCredentials}from'./auth-store.js';
import{AppError}from'./errors.js';
export function parseOAuthEnv(value:string):AuthCredentials{
 const allowed=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'],values:Record<string,string>={};
 for(const line of value.split(/\r?\n/)){
  if(!line.trim()||line.trim().startsWith('#'))continue;
  const match=/^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN)='([A-Za-z0-9._~+\/=\-]+)'$/.exec(line);
  if(!match||values[match[1]!])throw new AppError('OAuth-Sicherungsdatei hat ein unerwartetes Format; keine Werte ausgegeben.');values[match[1]!]=match[2]!;
 }
 if(allowed.some(key=>!values[key]))throw new AppError('OAuth-Sicherungsdatei ist unvollständig.');
 return{clientId:values.GOOGLE_CLIENT_ID!,clientSecret:values.GOOGLE_CLIENT_SECRET!,refreshToken:values.GOOGLE_REFRESH_TOKEN!};
}
export async function migrate(args:string[]){
 let fd:number|undefined;
 try{
  if(args.length!==4||args[0]!=='--from-env-file'||args[2]!=='--output-file'||!process.stdin.isTTY||!process.stdout.isTTY)throw new AppError('Privates Terminal nötig: auth:migrate --from-env-file /privat/oauth.env --output-file /privat/auth.json');
  const input=resolve(args[1]!),output=resolve(args[3]!);if(dirname(input)===dirname(output))throw new AppError('Auth-Speicher benötigt einen eigenen Unterordner ohne Client-JSON/OAuth-Sicherung.');
  const terminal=createInterface({input:process.stdin,output:process.stdout});let answer:string;try{answer=await terminal.question('Vorhandene OAuth-Zugangsdaten geschützt in neue auth.json übernehmen (kein Google-Aufruf)? MIGRATE eingeben: ');}finally{terminal.close();}
  if(answer!=='MIGRATE')throw new AppError('Übernahme abgebrochen.');
  fd=openSync(input,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);if(!s.isFile()||(s.mode&0o777)!==0o600||s.uid!==process.getuid?.()||s.size>65536)throw Error();
  const credentials=parseOAuthEnv(readFileSync(fd,'utf8'));new FileAuthStore(output).create(credentials);
  console.log('Geschützte auth.json angelegt; OAuth-Sicherung unverändert, keine Google-Anfragen.');return 0;
 }catch(error){console.error(error instanceof AppError?error.message:'Übernahme fehlgeschlagen; keine Dateiinhalte ausgegeben.');return 1;}
 finally{if(fd!==undefined)closeSync(fd);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await migrate(process.argv.slice(2));
