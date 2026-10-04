import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { open, lstat, realpath, unlink, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.js';
import {FileAuthStore,type AuthCredentials} from './auth-store.js';

// Event-only remains the default. Calendar-list reading requires an explicit setup option.
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const MAX_AGE = 5 * 60_000;
export interface OAuthCredentials { clientId: string; clientSecret: string }
export interface CallbackReply { status: number; message: string; code?: string }
export class OAuthSession {
 readonly state = randomBytes(32).toString('base64url');
 private verifier = randomBytes(64).toString('base64url');
 private consumed = false;
 private acceptedCode = '';
 constructor(readonly credentials: OAuthCredentials, readonly redirect: string, private created = Date.now(), readonly withCalendarList = false) {
  const url = new URL(redirect);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
   throw new AppError('OAuth benötigt einen lokalen IPv4-Loopback-Callback.');
 }
 authorizationURL() {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ client_id: this.credentials.clientId, redirect_uri: this.redirect, response_type: 'code', scope: this.withCalendarList?CALENDAR_SCOPE+' '+CALENDAR_LIST_SCOPE:CALENDAR_SCOPE, state: this.state, code_challenge: createHash('sha256').update(this.verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })) url.searchParams.set(key, value);
  return url.href;
 }
 acceptManualCallback(raw: string, now = Date.now()): CallbackReply {
  // Only a complete callback for this exact live loopback is accepted, never a bare code.
  if (raw.length > 16384 || !raw.startsWith(this.redirect + '?') || /[\s\u0000-\u001f\u007f#]/.test(raw))
   return { status: 400, message: 'Ungültige OAuth-Antwort.' };
  let url: URL;
  try { url = new URL(raw); } catch { return { status: 400, message: 'Ungültige OAuth-Antwort.' }; }
  if (url.username || url.password || url.origin !== new URL(this.redirect).origin || url.pathname !== '/' || url.hash)
   return { status: 400, message: 'Ungültige OAuth-Antwort.' };
  return this.accept('GET', url.host, url.pathname + url.search, now);
 }
 accept(method: string, host: string | undefined, target: string, now = Date.now()): CallbackReply {
  const invalid = { status: 400, message: 'Ungültige OAuth-Antwort.' };
  if (method !== 'GET' || target.length > 16384 || host !== new URL(this.redirect).host) return invalid;
  let url: URL;
  try { url = new URL(target, this.redirect); } catch { return invalid; }
  if (url.origin !== new URL(this.redirect).origin || url.pathname !== '/' || url.hash) return invalid;
  if (this.consumed || now - this.created > MAX_AGE) return { status: 410, message: 'OAuth-Sitzung abgelaufen oder bereits verwendet.' };
  const states = url.searchParams.getAll('state');
  const expected = Buffer.from(this.state), supplied = Buffer.from(states[0] ?? '');
  if (states.length !== 1 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return invalid;
  const codes = url.searchParams.getAll('code'), errors = url.searchParams.getAll('error');
  if (errors.length === 1 && codes.length === 0) { this.consumed = true; return { status: 403, message: 'Google-Zustimmung wurde nicht erteilt.' }; }
  if (errors.length || codes.length !== 1 || !codes[0] || codes[0].length > 8192) return invalid;
  this.consumed = true; this.acceptedCode = codes[0];
  return { status: 200, message: 'OAuth-Antwort lokal empfangen. Ergebnis im Setup-Terminal prüfen; dieses Fenster schließen.', code: codes[0] };
 }
 async exchange(code: string, fetcher: typeof fetch = fetch) {
  if (!this.consumed || !this.verifier || !this.acceptedCode || code !== this.acceptedCode) throw new AppError('OAuth-Antwort fehlt oder wurde bereits ausgetauscht.');
  const verifier = this.verifier; this.verifier = ''; this.acceptedCode = '';
  try {
   const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret, redirect_uri: this.redirect }), signal: AbortSignal.timeout(30_000) });
   if (!response.ok) throw Error();
   const data = await response.json() as Record<string, unknown>;
   if (typeof data.scope !== 'string' || ![CALENDAR_SCOPE,...this.withCalendarList?[CALENDAR_LIST_SCOPE]:[]].every(scope=>(data.scope as string).split(/\s+/).includes(scope)) || typeof data.refresh_token !== 'string' || !data.refresh_token || data.token_type !== 'Bearer') throw Error();
   return data.refresh_token;
  } catch { throw new AppError('OAuth-Austausch fehlgeschlagen oder notwendige Event-Berechtigung/Refresh-Token fehlt. Keine Antwortdetails ausgegeben.'); }
 }
}

export function setupCredentials(env: NodeJS.ProcessEnv): OAuthCredentials {
 if (env.GOOGLE_OAUTH_CLIENT_FILE) {
  if (['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_ID_FILE','GOOGLE_CLIENT_SECRET','GOOGLE_CLIENT_SECRET_FILE'].some(name=>env[name])) throw new AppError('Client-JSON und Client-ENV nicht gleichzeitig setzen.');
  try {
   const data = JSON.parse(readFileSync(env.GOOGLE_OAUTH_CLIENT_FILE,'utf8')) as {installed?:{client_id?:unknown;client_secret?:unknown}};
   if(typeof data.installed?.client_id!=='string'||typeof data.installed.client_secret!=='string'||!data.installed.client_id||!data.installed.client_secret) throw Error();
   return {clientId:data.installed.client_id,clientSecret:data.installed.client_secret};
  }catch {throw new AppError('Lokale Google-Client-JSON muss gültige Desktop-Clientdaten enthalten; keine Dateiinhalte ausgegeben.');}
 }
 function value(name: string) {
  const direct = env[name] ?? '', file = env[name + '_FILE'] ?? '';
  if (direct && file) throw new AppError('ENV und _FILE dürfen nicht gleichzeitig gesetzt sein.');
  try { return file ? readFileSync(file, 'utf8').trim() : direct; } catch { throw new AppError('OAuth-Clientdatei nicht lesbar.'); }
 }
 const clientId = value('GOOGLE_CLIENT_ID'), clientSecret = value('GOOGLE_CLIENT_SECRET');
 if (!clientId || !clientSecret) throw new AppError('Desktop-Client-ID und Client-Secret privat über ENV oder _FILE bereitstellen.');
 return { clientId, clientSecret };
}

export async function reservePrivateOutput(filename: string) {
 if (!isAbsolute(filename)) throw new AppError('OAuth-Ausgabedatei muss absolut angegeben sein.');
 const parent = dirname(filename), canonical = await realpath(parent);
 const metadata = await lstat(parent);
 const project = resolve('.'), withinProject = relative(project, resolve(filename));
 const insideProject = withinProject!=='..' && !withinProject.startsWith('..'+sep) && !isAbsolute(withinProject);
 const ignored = (file:string) => {try{return readFileSync(join(project,file),'utf8').split(/\r?\n/).some(line=>['.local/','/.local/','.local','/.local'].includes(line.trim()));}catch{return false;}};
 const localRelative=relative(join(project,'.local'),parent);
 const privateLocal = (localRelative===''||(!localRelative.includes(sep)&&localRelative!=='..'&&!isAbsolute(localRelative))) && ignored('.gitignore') && ignored('.dockerignore');
 if (canonical !== parent || !metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid?.() || (insideProject && !privateLocal))
  throw new AppError('Ausgabe benötigt einen privaten Ordner mit Rechten 0700 ohne Symlinks: außerhalb des Projekts oder dessen Git-/Docker-ignorierte .local.');
 if(filename.endsWith('.json')){
  const store=new FileAuthStore(filename);const previous:AuthCredentials|undefined=existsSync(filename)?store.read():undefined;
  // Check writable directory before opening Google; no credential file is created.
  const probe=join(parent,'.oauth-setup-'+randomBytes(16).toString('hex'));
  const handle=await open(probe,'wx',0o600);await handle.close();await unlink(probe);
  return {async save(credentials:OAuthCredentials,refreshToken:string){const next={...credentials,refreshToken};if(previous)await store.replace(next,previous);else store.create(next);},async abort(){}};
 }
 const handle = await open(filename, 'wx', 0o600);
 let finished = false;
 return {
  async save(credentials: OAuthCredentials, refreshToken: string) {
   const values = { GOOGLE_CLIENT_ID: credentials.clientId, GOOGLE_CLIENT_SECRET: credentials.clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken };
   // Safe single-quoted Compose dotenv values; no interpolation or control characters.
   if (Object.values(values).some(value => !/^[A-Za-z0-9._~+\/=\-]+$/.test(value))) throw new AppError('OAuth-Ausgabeformat ungültig; keine Tokens ausgegeben.');
   await handle.writeFile(Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n');
   await handle.sync(); await handle.close(); finished = true;
  },
  async abort() { if (!finished) { await handle.close().catch(() => undefined); await unlink(filename).catch(() => undefined); } },
 };
}

export function openLocalBrowser(url: string) {
 const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open';
 if (!command) throw new AppError('Dieses Setup unterstützt lokale Browser auf macOS/Linux.');
 return new Promise<void>((ok, fail) => {
  const child = spawn(command, [url], { stdio: 'ignore', shell: false });
  child.once('error', () => fail(new AppError('Browserstart fehlgeschlagen; keine OAuth-URL ausgegeben.')));
  child.once('exit', code => code === 0 ? ok() : fail(new AppError('Browserstart fehlgeschlagen; keine OAuth-URL ausgegeben.')));
 });
}

// Hidden raw TTY input: no echo, readline history, argv, files or callback logging.
export function readHiddenCallback(input: NodeJS.ReadStream, output: NodeJS.WriteStream, signal: AbortSignal): Promise<string> {
 return new Promise((resolveInput, rejectInput) => {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function' || signal.aborted) {
   rejectInput(new AppError('Verdeckte Callback-Eingabe benötigt ein privates interaktives Terminal.')); return;
  }
  const previousRaw = input.isRaw, previousPaused = input.isPaused();
  let pending = '', finished = false;
  const finish = (error?: AppError, value?: string) => {
   if (finished) return; finished = true;
   pending = '';
   input.off('data', data); input.off('end', closed); input.off('close', closed); input.off('error', closed);
   signal.removeEventListener('abort', aborted);
   try { input.setRawMode(previousRaw); if (previousPaused) input.pause(); } catch { error = new AppError('Setup-Terminal nicht mehr verfügbar; keine Eingabedetails ausgegeben.'); }
   try { output.write('\n'); } catch { error = new AppError('Setup-Terminal nicht mehr verfügbar; keine Eingabedetails ausgegeben.'); }
   if (error) rejectInput(error); else resolveInput(value!);
  };
  const aborted = () => finish(new AppError('Verdeckte Callback-Eingabe abgebrochen.'));
  const closed = () => finish(new AppError('Privates Setup-Terminal geschlossen.'));
  const data = (chunk: Buffer | string) => {
   for (const character of chunk.toString()) {
    if (character === '\u0003' || character === '\u0004') { aborted(); return; }
    if (character === '\r' || character === '\n') { finish(undefined, pending); return; }
    if (character === '\u007f' || character === '\b') { pending = pending.slice(0, -1); continue; }
    if (/[\u0000-\u001f]/.test(character) || pending.length >= 16384) {
     finish(new AppError('Callback-Eingabe ungültig oder zu lang; keine Eingabedetails ausgegeben.')); return;
    }
    pending += character;
   }
  };
  try { input.setRawMode(true); } catch { finish(new AppError('Verdeckte Eingabe nicht verfügbar; keine Eingabedetails ausgegeben.')); return; }
  input.on('data', data); input.once('end', closed); input.once('close', closed); input.once('error', closed);
  signal.addEventListener('abort', aborted, { once: true });
  try {
   output.write('Originale Rückleitungs-URL verdeckt einfügen und Enter drücken (nur freigegebener privater Kanal, Ctrl-C bricht ab): ');
   input.resume();
  } catch { finish(new AppError('Verdeckte Eingabe nicht verfügbar; keine Eingabedetails ausgegeben.')); }
 });
}

export async function runOAuthSetup(args: string[], env = process.env) {
 let server: Server | undefined;
 let output: Awaited<ReturnType<typeof reservePrivateOutput>> | undefined;
 let timer: ReturnType<typeof setTimeout> | undefined;
 const manualAbort = new AbortController();
 let cancelled = false;
 let rejectPending: ((error: AppError) => void) | undefined;
 const stop = () => { cancelled = true; rejectPending?.(new AppError('OAuth-Setup abgebrochen.')); server?.closeAllConnections(); server?.close(); };
 try {
  const withCalendarList=args.includes('--with-calendar-list'),manualCallback=args.includes('--manual-callback'),showAuthorizationURL=args.includes('--show-authorization-url'),outputArgs=args.filter(a=>!['--with-calendar-list','--manual-callback','--show-authorization-url'].includes(a));
  if (!process.stdin.isTTY || !process.stdout.isTTY || args.filter(a=>a==='--with-calendar-list').length>1 || args.filter(a=>a==='--manual-callback').length>1 || args.filter(a=>a==='--show-authorization-url').length>1 || (showAuthorizationURL && !manualCallback) || !(outputArgs.length===0||outputArgs.length===2&&outputArgs[0]==='--output-file'))
   throw new AppError('Interaktives privates Terminal nötig: npm run oauth:setup [-- --with-calendar-list --manual-callback [--show-authorization-url] --output-file /privat/auth.json]');
  const actualEnv={...env};
  if(!actualEnv.GOOGLE_OAUTH_CLIENT_FILE&&!['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_ID_FILE','GOOGLE_CLIENT_SECRET','GOOGLE_CLIENT_SECRET_FILE'].some(name=>actualEnv[name])){
   const candidates=readdirSync(resolve('.local')).filter(name=>name.endsWith('.json'));
   if(candidates.length!==1)throw new AppError('Desktop-JSON in .local nicht eindeutig; GOOGLE_OAUTH_CLIENT_FILE privat angeben.');
   actualEnv.GOOGLE_OAUTH_CLIENT_FILE=resolve('.local',candidates[0]!);
  }
  const credentials = setupCredentials(actualEnv);
  const filename=outputArgs.length?outputArgs[1]!:resolve('.local/auth-store/auth.json');
  if(!outputArgs.length)await mkdir(dirname(filename),{recursive:true,mode:0o700});
  output = await reservePrivateOutput(filename);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let consent: string;
  try { consent = await terminal.question(withCalendarList?'Google calendar.events + calendar.calendarlist.readonly und lokalen Refresh-Token anfordern? AUTHORIZE eingeben (kein Kalender-Sync): ':'Google-Eventberechtigung und lokalen Refresh-Token anfordern? AUTHORIZE eingeben (kein Kalender-Sync): '); } finally { terminal.close(); }
  if (consent !== 'AUTHORIZE') throw new AppError('OAuth-Setup ohne Anmeldung abgebrochen.');
  let session: OAuthSession | undefined;
  let receive!: (code: string) => void, reject!: (error: AppError) => void;
  const received = new Promise<string>((ok, fail) => { receive = ok; reject = fail; });
  rejectPending = reject;
  // Attach immediately so listen/browser failures cannot leave an unhandled rejection.
  void received.catch(() => undefined);
  server = createServer((request, response) => {
   const reply = session?.accept(request.method ?? '', request.headers.host, request.url ?? '') ?? { status: 503, message: 'Setup noch nicht bereit.' };
   response.writeHead(reply.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
   response.end(reply.message);
   if (reply.code) receive(reply.code);
   else if (reply.status === 403) reject(new AppError(reply.message));
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxConnections = 8;
  await new Promise<void>((ok, fail) => { server!.once('error', () => fail(new AppError('OAuth-Loopback nicht verfügbar; Socketfreigabe prüfen.'))); server!.listen(0, '127.0.0.1', () => ok()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new AppError('Lokaler OAuth-Callback nicht verfügbar.');
  session = new OAuthSession(credentials, `http://127.0.0.1:${address.port}/`,Date.now(),withCalendarList);
  timer = setTimeout(() => reject(new AppError('OAuth-Setup nach fünf Minuten abgebrochen.')), MAX_AGE);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  // Explicit handoff contains only the official authorize parameters, never clientSecret or verifier.
  if (showAuthorizationURL) console.log('Google-Autorisierung: ' + session.authorizationURL());
  await openLocalBrowser(session.authorizationURL());
  if (manualCallback) {
   console.log('Manuelle Rückleitung ist optional. Nur die originale Rückleitung dieser laufenden Sitzung über den bewusst freigegebenen privaten Kanal übergeben; keine Access-/Refresh-Tokens teilen.');
   void readHiddenCallback(process.stdin, process.stdout, manualAbort.signal).then(raw => {
    const reply = session!.acceptManualCallback(raw);
    if (reply.code) receive(reply.code); else reject(new AppError(reply.message));
   }, () => reject(new AppError('Manuelle Callback-Eingabe abgebrochen oder ungültig.')));
  }
  const code = await received;
  manualAbort.abort();
  server.closeAllConnections(); server.close();
  if (cancelled) throw new AppError('OAuth-Setup abgebrochen.');
  const refreshToken = await session.exchange(code);
  if (cancelled) throw new AppError('OAuth-Setup abgebrochen.');
  await output.save(credentials, refreshToken);
  console.log('OAuth-Konfiguration in der angegebenen privaten Datei gespeichert. Keine Kalenderanfragen oder Writes ausgeführt.');
  return 0;
 } catch (error) {
  console.error(error instanceof AppError ? error.message : 'OAuth-Setup fehlgeschlagen; keine Fehlerdetails oder Tokens ausgegeben.');
  return 1;
 } finally {
  manualAbort.abort();
  if (timer) clearTimeout(timer);
  server?.closeAllConnections(); server?.close();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  await output?.abort();
 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runOAuthSetup(process.argv.slice(2));
