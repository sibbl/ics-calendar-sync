import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdtemp, chmod, readFile, stat, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthSession, readHiddenCallback, CALENDAR_LIST_SCOPE, CALENDAR_SCOPE, reservePrivateOutput, setupCredentials, runOAuthSetup } from '../server/oauth-setup';
const credentials = { clientId: 'synthetic.apps.googleusercontent.com', clientSecret: 'synthetic-secret' };
const redirect = 'http://127.0.0.1:12345/';
function accepted() {
 const session = new OAuthSession(credentials, redirect);
 const result = session.accept('GET', '127.0.0.1:12345', '/?state=' + session.state + '&code=synthetic-code');
 expect(result.code).toBe('synthetic-code');
 return session;
}
describe('initial OAuth using synthetic transports only', () => {
 it('uses random independent state, PKCE S256 and only event permission', () => {
  const session = new OAuthSession(credentials, redirect), other = new OAuthSession(credentials, redirect);
  const url = new URL(session.authorizationURL());
  expect(session.state).not.toBe(other.state); expect(session.state.length).toBeGreaterThanOrEqual(43);
  expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('scope')).toBe(CALENDAR_SCOPE);
  expect(url.searchParams.get('redirect_uri')).toBe(redirect); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('access_type')).toBe('offline'); expect(url.searchParams.get('prompt')).toBe('consent');
  expect(url.href).not.toContain(credentials.clientSecret);
 });
 it('rejects public, TLS, named-host and credentialed callbacks', () => {
  for (const url of ['https://127.0.0.1:12345/', 'http://0.0.0.0:12345/', 'http://localhost:12345/', 'http://user@127.0.0.1:12345/', 'http://127.0.0.1:12345/path', 'http://127.0.0.1:12345/?x=y']) expect(() => new OAuthSession(credentials, url)).toThrow();
 });
 it('rejects missing/wrong/duplicate state, host, method, origin and duplicate codes', () => {
  const s = new OAuthSession(credentials, redirect), valid = '/?state=' + s.state + '&code=synthetic-code';
  for (const [method, host, path] of [['POST','127.0.0.1:12345',valid],['GET','foreign.invalid',valid],['GET','127.0.0.1:12345','/?code=synthetic-code'],['GET','127.0.0.1:12345',valid+'&state='+s.state],['GET','127.0.0.1:12345',valid+'&code=duplicate'],['GET','127.0.0.1:12345','/?state=wrong&code=synthetic-code'],['GET','127.0.0.1:12345','http://foreign.invalid'+valid]]) expect(s.accept(method,host,path).status).toBe(400);
  expect(s.accept('GET','127.0.0.1:12345',valid).status).toBe(200);
 });
 it('expires and rejects callback replay', () => {
  const expired = new OAuthSession(credentials, redirect, 0);
  expect(expired.accept('GET','127.0.0.1:12345','/?state='+expired.state+'&code=synthetic',300001).status).toBe(410);
  const used = accepted(); expect(used.accept('GET','127.0.0.1:12345','/?state='+used.state+'&code=synthetic-code').status).toBe(410);
 });
 it('does not exchange denied or unaccepted callbacks', async () => {
  const s = new OAuthSession(credentials, redirect), transport = vi.fn();
  expect(s.accept('GET','127.0.0.1:12345','/?state='+s.state+'&error=access_denied').status).toBe(403);
  await expect(s.exchange('synthetic-code',transport)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
  await expect(new OAuthSession(credentials,redirect).exchange('synthetic-code',transport)).rejects.toThrow();
 });
 it('exchanges only accepted code with matching PKCE, never calls Calendar and rejects reuse', async () => {
  const s = accepted(), challenge = new URL(s.authorizationURL()).searchParams.get('code_challenge');
  const transport = vi.fn(async (_url: any, options: RequestInit = {}) => {
   const body = options.body as URLSearchParams;
   expect(body.get('grant_type')).toBe('authorization_code'); expect(body.get('code')).toBe('synthetic-code');
   expect(body.get('redirect_uri')).toBe(redirect); expect(body.get('client_secret')).toBe(credentials.clientSecret);
   expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
   expect(options.redirect).toBe('error');
   return Response.json({ refresh_token: 'synthetic-refresh', access_token: 'synthetic-discarded', scope: CALENDAR_SCOPE, token_type: 'Bearer' });
  });
  await expect(s.exchange('wrong',transport)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
  expect(await s.exchange('synthetic-code',transport)).toBe('synthetic-refresh');
  expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
  await expect(s.exchange('synthetic-code',transport)).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(1);
 });
 it('sanitizes remote failures and refuses missing refresh token or scope', async () => {
  for (const response of [new Response('PRIVATE_RESPONSE_SECRET',{status:400}),Response.json({refresh_token:'synthetic',token_type:'Bearer',scope:'openid'}),Response.json({token_type:'Bearer',scope:CALENDAR_SCOPE})]) {
   const s = accepted(); await expect(s.exchange('synthetic-code',vi.fn(async()=>response))).rejects.toThrow('Keine Antwortdetails');
  }
 });
 it('supports private client files and rejects conflicting or missing credentials', async () => {
  const dir=await mkdtemp(join(tmpdir(),'oauth-client-test-'));
  try {const file=join(dir,'client');await writeFile(file,'synthetic-secret\n');expect(setupCredentials({GOOGLE_CLIENT_ID:credentials.clientId,GOOGLE_CLIENT_SECRET_FILE:file})).toEqual(credentials);expect(()=>setupCredentials({})).toThrow();expect(()=>setupCredentials({GOOGLE_CLIENT_ID:credentials.clientId,GOOGLE_CLIENT_SECRET:'synthetic',GOOGLE_CLIENT_SECRET_FILE:file})).toThrow();}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('reads downloaded Desktop client JSON locally and refuses web clients or conflicting ENV',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oauth-json-test-')),file=join(dir,'desktop.json');
  try {await writeFile(file,JSON.stringify({installed:{client_id:credentials.clientId,client_secret:credentials.clientSecret}}));expect(setupCredentials({GOOGLE_OAUTH_CLIENT_FILE:file})).toEqual(credentials);expect(()=>setupCredentials({GOOGLE_OAUTH_CLIENT_FILE:file,GOOGLE_CLIENT_ID:'conflict'})).toThrow();await writeFile(file,JSON.stringify({web:{client_id:'synthetic',client_secret:'synthetic'}}));expect(()=>setupCredentials({GOOGLE_OAUTH_CLIENT_FILE:file})).toThrow('Desktop');}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('requires an explicit interactive terminal before browser, socket or network work', async () => {
  const log = vi.spyOn(console,'error').mockImplementation(()=>undefined);
  expect(await runOAuthSetup([],{})).toBe(1); expect(log.mock.calls.flat().join(' ')).toContain('Interaktives privates Terminal'); expect(fetch).not.toHaveBeenCalled();
 });
});
describe('private ENV handoff, only synthetic credentials written', () => {
 async function folder() {const dir=await realpath(await mkdtemp(join(tmpdir(),'oauth-output-test-')));await chmod(dir,0o700);return dir;}
 it('writes 0600 single-quoted ENV, no access token, never overwrites', async () => {
  const dir=await folder(),file=join(dir,'oauth.env');
  try {const output=await reservePrivateOutput(file);await output.save(credentials,'synthetic-refresh');await output.abort();expect((await stat(file)).mode&0o777).toBe(0o600);const value=await readFile(file,'utf8');expect(value).toContain("GOOGLE_REFRESH_TOKEN='synthetic-refresh'");expect(value).not.toContain('ACCESS_TOKEN');await expect(reservePrivateOutput(file)).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(value);}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('removes an unfinished reservation and refuses interpolation/injection', async () => {
  const dir=await folder(),file=join(dir,'oauth.env');
  try {const output=await reservePrivateOutput(file);await expect(output.save(credentials,"bad'\nENABLE_GOOGLE_WRITES=true")).rejects.toThrow();await output.abort();await expect(stat(file)).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('refuses public directories, relative paths and symlinked directories/files', async () => {
  const dir=await folder(),file=join(dir,'oauth.env');
  try {await expect(reservePrivateOutput('relative.env')).rejects.toThrow();await chmod(dir,0o755);await expect(reservePrivateOutput(file)).rejects.toThrow();await chmod(dir,0o700);await symlink(dir,dir+'-link');await expect(reservePrivateOutput(join(dir+'-link','oauth.env'))).rejects.toThrow();await writeFile(join(dir,'existing'),'synthetic');await symlink(join(dir,'existing'),file);await expect(reservePrivateOutput(file)).rejects.toThrow();expect(await readFile(join(dir,'existing'),'utf8')).toBe('synthetic');}finally{await rm(dir+'-link',{force:true});await rm(dir,{recursive:true,force:true});}
 });
});

describe('explicit private .local handoff',()=>{
 it('only permits a project .local output when both Git and Docker exclude it',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'oauth-local-project-test-'))),folder=join(root,'.local'),file=join(folder,'oauth.env');
  const {mkdir}=await import('node:fs/promises');await mkdir(folder,{mode:0o700});vi.spyOn(process,'cwd').mockReturnValue(root);
  try {
   await expect(reservePrivateOutput(file)).rejects.toThrow();await writeFile(join(root,'.gitignore'),'.local/\n');await expect(reservePrivateOutput(file)).rejects.toThrow();await writeFile(join(root,'.dockerignore'),'.local/\n');
   await chmod(folder,0o755);await expect(reservePrivateOutput(file)).rejects.toThrow();await chmod(folder,0o700);
   const output=await reservePrivateOutput(file);await output.save(credentials,'synthetic-private-local');expect((await stat(file)).mode&0o777).toBe(0o600);expect(await readFile(file,'utf8')).toContain('synthetic-private-local');await expect(reservePrivateOutput(file)).rejects.toThrow();
   const exposed=join(root,'unprotected');await mkdir(exposed,{mode:0o700});await expect(reservePrivateOutput(join(exposed,'oauth.env'))).rejects.toThrow();
  }finally{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
 });
});


describe('optional manual callback uses the original live OAuth session', () => {
 const callback = (session: OAuthSession) => redirect + '?state=' + session.state + '&code=synthetic-manual-code';
 it('requires the full exact original redirect and state, rejecting malformed or normalized alternatives', () => {
  const session = new OAuthSession(credentials, redirect), valid = callback(session);
  for (const raw of ['synthetic-manual-code', '/?state='+session.state+'&code=synthetic', valid.replace(':12345', ':54321'), valid.replace('127.0.0.1', 'localhost'), valid.replace('127.0.0.1', '2130706433'), valid.replace('http:', 'https:'), valid.replace('127.0.0.1', 'user@127.0.0.1'), valid.replace('/?', '/path?'), valid.replace('/?', '/./?'), valid+'#fragment', valid+'\n', valid.replace(session.state,'foreign-state'), valid+'&state='+session.state, valid+'&code=duplicate', redirect+'?code=synthetic', valid+'&error=access_denied', valid+'&padding='+'x'.repeat(16384)]) {
   const reply = session.acceptManualCallback(raw);
   expect(reply.status).toBe(400); expect(reply.code).toBeUndefined(); expect(reply.message).not.toContain('synthetic');
  }
  expect(session.acceptManualCallback(valid).status).toBe(200);
 });
 it('shares one-time consumption across both callback transports, including denied consent', () => {
  const manual = new OAuthSession(credentials, redirect);
  expect(manual.acceptManualCallback(callback(manual)).status).toBe(200);
  expect(manual.accept('GET','127.0.0.1:12345',callback(manual)).status).toBe(410);
  expect(manual.acceptManualCallback(callback(manual)).status).toBe(410);
  const browser = accepted(); expect(browser.acceptManualCallback(callback(browser)).status).toBe(410);
  const denied = new OAuthSession(credentials, redirect);
  expect(denied.acceptManualCallback(redirect+'?state='+denied.state+'&error=access_denied').status).toBe(403);
  expect(denied.acceptManualCallback(callback(denied)).status).toBe(410);
 });
 it('rejects expired callbacks without a token exchange', async () => {
  const session = new OAuthSession(credentials, redirect, 0), transport = vi.fn();
  expect(session.acceptManualCallback(callback(session), 300001).status).toBe(410);
  await expect(session.exchange('synthetic-manual-code',transport)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
 });
 it('exchanges manual completion once with the original PKCE and both approved scopes, persisting only after success', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'oauth-manual-test-')));await chmod(dir,0o700);
  try {
   const session=new OAuthSession(credentials,redirect,Date.now(),true);
   const challenge=new URL(session.authorizationURL()).searchParams.get('code_challenge');
   const file=join(dir,'auth.json'), output=await reservePrivateOutput(file);
   const reply=session.acceptManualCallback(callback(session));
   const transport=vi.fn(async (_url:any, options:RequestInit={})=>{
    const body=options.body as URLSearchParams;
    expect(body.get('redirect_uri')).toBe(redirect);expect(body.get('code')).toBe('synthetic-manual-code');
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
    return Response.json({refresh_token:'synthetic-manual-refresh',scope:CALENDAR_SCOPE+' '+CALENDAR_LIST_SCOPE,token_type:'Bearer'});
   });
   await output.save(credentials,await session.exchange(reply.code!,transport));await output.abort();
   expect(JSON.parse(await readFile(file,'utf8')).refreshToken).toBe('synthetic-manual-refresh');expect((await stat(file)).mode&0o777).toBe(0o600);
   await expect(session.exchange(reply.code!,transport)).rejects.toThrow();expect(transport).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});

describe('manual callback input never echoes callback details', () => {
 function tty() {
  const input=new PassThrough() as PassThrough & {isTTY:boolean;isRaw:boolean;setRawMode:ReturnType<typeof vi.fn>};
  input.isTTY=true;input.isRaw=false;input.setRawMode=vi.fn((enabled:boolean)=>{input.isRaw=enabled;return input;});input.pause();
  const output=new PassThrough() as PassThrough & {isTTY:boolean};output.isTTY=true;
  let visible='';output.on('data',chunk=>{visible+=chunk.toString();});
  return {input,output,visible:()=>visible,read:(signal:AbortSignal)=>readHiddenCallback(input as unknown as NodeJS.ReadStream,output as unknown as NodeJS.WriteStream,signal)};
 }
 it('reads split pasted input without echo/history and restores terminal mode/listeners', async () => {
  const t=tty(), controller=new AbortController(), pending=t.read(controller.signal);
  expect(t.input.isRaw).toBe(true);
  t.input.write('http://127.0.0.1:12345/?state=synthetic-private&code=');t.input.write('synthetic-secret\r');
  expect(await pending).toContain('code=synthetic-secret');expect(t.visible()).not.toContain('synthetic');expect(t.visible()).not.toContain('127.0.0.1');
  expect(t.input.isRaw).toBe(false);expect(t.input.isPaused()).toBe(true);expect(t.input.listenerCount('data')).toBe(0);
 });
 it('restores raw mode and discards hidden input on timeout/cancellation or Ctrl-C', async () => {
  for (const cancel of ['abort','ctrl-c','close']) {
   const t=tty(),controller=new AbortController();t.input.isRaw=true;
   const pending=t.read(controller.signal);t.input.write('synthetic-secret');
   if(cancel==='abort')controller.abort();else if(cancel==='ctrl-c')t.input.write('\u0003');else t.input.emit('close');
   await expect(pending).rejects.toThrow();expect(t.visible()).not.toContain('synthetic');expect(t.input.isRaw).toBe(true);expect(t.input.listenerCount('data')).toBe(0);
  }
 });
 it('cleans up if the terminal fails while displaying the prompt', async () => {
  const t=tty();vi.spyOn(t.output,'write').mockImplementation(()=>{throw Error('synthetic-private-error');});
  await expect(t.read(new AbortController().signal)).rejects.toThrow('keine Eingabedetails');
  expect(t.input.isRaw).toBe(false);expect(t.input.listenerCount('data')).toBe(0);
 });
 it('rejects oversized/control input and non-TTY input without disclosure', async () => {
  for(const raw of ['x'.repeat(16385),'synthetic-secret\u001b']) {
   const t=tty(),pending=t.read(new AbortController().signal);t.input.write(raw);
   await expect(pending).rejects.toThrow('keine Eingabedetails');expect(t.input.isRaw).toBe(false);expect(t.visible()).not.toContain('synthetic-secret');
  }
  const t=tty();t.input.isTTY=false;await expect(t.read(new AbortController().signal)).rejects.toThrow('privates interaktives Terminal');expect(t.input.setRawMode).not.toHaveBeenCalled();
 });
});
