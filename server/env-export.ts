import type {Source} from '../shared/contracts.js';
// Single quotes prevent dotenv/Compose interpolation. Only a configuration allowlist is exported.
export function dotenvQuote(value:string){return "'"+value.replaceAll("'","\\'")+"'";}
export function exportConfiguration(sources:Source[],calendarId:string){
 const safe=sources.map(s=>({id:s.id,name:s.name,kind:s.kind,...s.sourceCalendarId?{sourceCalendarId:s.sourceCalendarId}:{},...s.folderMode?{folderMode:s.folderMode}:{},...s.snapshotFile?{snapshotFile:s.snapshotFile}:{},...s.snapshotScope?{snapshotScope:s.snapshotScope}:{},...s.fileHandling?{fileHandling:s.fileHandling}:{},...s.immutableFilesConfirmed!==undefined?{immutableFilesConfirmed:s.immutableFilesConfirmed}:{},location:s.kind==='url'?'REPLACE_WITH_SOURCE_URL':s.location,calendarId:s.calendarId??'',enabled:s.enabled,watch:s.watch,intervalSeconds:s.intervalSeconds,...s.cron?{cron:s.cron}:{},cronTimezone:s.cronTimezone,rules:s.rules}));
 const SOURCES_JSON=JSON.stringify(safe);
 const env=['# URLs lokal ersetzen. Upload-Inhalte werden nicht exportiert.','# Nur diese Konfigurationswerte in die bestehende .env übernehmen.', 'GOOGLE_CALENDAR_ID='+dotenvQuote(calendarId),'SOURCES_JSON='+dotenvQuote(SOURCES_JSON),''].join('\n');
 return {SOURCES_JSON,env,note:'URL-Platzhalter lokal ersetzen. Quellen/Zielauswahl sind flüchtig; Admin- und OAuth-Zugangsdaten sind nicht enthalten.'};
}
