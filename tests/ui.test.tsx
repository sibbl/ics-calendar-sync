// @vitest-environment jsdom
import{it,expect,vi,afterEach,beforeEach}from'vitest';import{render,screen,fireEvent,waitFor,cleanup}from'@testing-library/react';import'@testing-library/jest-dom/vitest';import App from'../src/App';import{ADMIN_TOKEN_STORAGE_KEY}from'../src/lib/admin-token-storage';import{SOURCE,SID,BASE,ics}from'./fixtures';import{parseCalendar}from'../server/calendar';
beforeEach(()=>localStorage.clear());afterEach(cleanup);
function loginSynthetic(){fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:'synthetic-only'}});fireEvent.click(screen.getByRole('button',{name:'Öffnen'}));}
function responses(){const state={sources:[SOURCE],statuses:{},writesEnabled:false,oauthConfigured:false,ephemeral:true,demo:true};const transport=vi.fn(async(url:any,options:RequestInit={})=>{if(String(url).endsWith('/state'))return Response.json(state);if(String(url).endsWith('/preview'))return Response.json(parseCalendar(ics([BASE]),SID));if(String(url).endsWith('/upload'))return Response.json({ok:true});return Response.json({error:'Unexpected request'},{status:400});});vi.stubGlobal('fetch',transport);return transport;}
it('opens demo and renders a sanitized preview with writes disabled',async()=>{const transport=responses();render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');expect(screen.getByRole('button',{name:'Synchronisieren'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Vorschau'}));await screen.findByRole('table',{name:'Anonymisierte Termine'});expect(screen.getByText('Termin')).toBeInTheDocument();expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();expect(transport).toHaveBeenCalled();});
it('uploads an ICS and automatically shows its preview',async()=>{const transport=responses();render(<App/>);loginSynthetic();await screen.findByLabelText('Upload für Synthetic');const file=new File([ics([BASE])],'synthetic.ics',{type:'text/calendar'});fireEvent.change(screen.getByLabelText('Upload für Synthetic'),{target:{files:[file]}});await screen.findByText('Termin');expect(transport.mock.calls.some(([url])=>String(url).endsWith('/upload'))).toBe(true);});
it('shows sanitized server errors and only persists the entered token under its project key',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'Admin-Token erforderlich.'},{status:401})));const storage=vi.spyOn(Storage.prototype,'setItem');render(<App/>);fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:'synthetic-only'}});fireEvent.click(screen.getByRole('button',{name:'Öffnen'}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Admin-Token erforderlich.'));expect(storage).toHaveBeenCalledWith(ADMIN_TOKEN_STORAGE_KEY,'synthetic-only');});
it('keeps source settings out of the main view and preserves configurable rules',async()=>{
 responses();render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');
 expect(screen.queryByLabelText('Titel ausschließen (RegEx)')).not.toBeInTheDocument();
 expect(screen.queryByText(/Deine Zeit|Ohne deine Termindetails|ENV-first/)).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Einstellungen'}));
 expect(screen.getByLabelText('Titel ausschließen (RegEx)')).toHaveValue('^Mittagspause$');
 expect(screen.getByLabelText('Automatisch prüfen')).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Abbrechen'}));
 expect(screen.queryByLabelText('Titel ausschließen (RegEx)')).not.toBeInTheDocument();
});
it('clears the previous source preview when selecting another source',async()=>{
 const sources=[SOURCE,{...SOURCE,id:'00000000-0000-4000-8000-000000000002',name:'Second'}];
 vi.stubGlobal('fetch',vi.fn(async(url:any)=>String(url).endsWith('/state')?Response.json({sources,statuses:{},writesEnabled:false,oauthConfigured:false,ephemeral:true,demo:true}):Response.json(parseCalendar(ics([BASE]),SID))));
 render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');
 fireEvent.click(screen.getByRole('button',{name:'Vorschau'}));await screen.findByRole('table',{name:'Anonymisierte Termine'});
 fireEvent.change(screen.getByLabelText('Quelle'),{target:{value:sources[1].id}});
 expect(screen.queryByRole('table')).not.toBeInTheDocument();expect(screen.getByLabelText('Upload für Second')).toBeInTheDocument();
});

it('explains the three settings on focus, click and hover without submitting or changing them',async()=>{
 const transport=responses();render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');fireEvent.click(screen.getByRole('button',{name:'Einstellungen'}));
 const calls=transport.mock.calls.length;
 const interval=screen.getByRole('button',{name:'Info: Intervall (Sekunden)'});
 expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
 fireEvent.focus(interval);expect(screen.getByRole('tooltip')).toHaveTextContent('300 Sekunden = 5 Minuten');expect(screen.getByRole('tooltip')).toHaveTextContent('Cron-Ausdruck hat Vorrang');
 expect(interval).toHaveAttribute('aria-describedby',screen.getByRole('tooltip').id);
 fireEvent.keyDown(interval,{key:'Escape'});expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
 fireEvent.blur(interval);fireEvent.click(screen.getByRole('button',{name:'Info: Busy-Regel'}));expect(screen.getByRole('tooltip')).toHaveTextContent('FREE und TENTATIVE nicht');expect(screen.getByRole('tooltip')).toHaveTextContent('Titelfilter und Absagen gelten weiterhin');
 fireEvent.blur(screen.getByRole('button',{name:'Info: Busy-Regel'}));
 const automatic=screen.getByRole('button',{name:'Info: Automatisch prüfen'});fireEvent.mouseEnter(automatic);expect(screen.getByRole('tooltip')).toHaveTextContent('ENABLE_GOOGLE_WRITES=true');fireEvent.mouseLeave(automatic);expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
 expect(screen.getByLabelText('Intervall (Sekunden)')).toHaveValue(300);expect(screen.getByLabelText('Busy-Regel')).toHaveValue('outlook_busy');expect(screen.getByLabelText('Automatisch prüfen')).not.toBeChecked();expect(transport).toHaveBeenCalledTimes(calls);
});

it('automatically authenticates a saved token after remount and forgets it on logout',async()=>{
 const transport=responses();const first=render(<App/>);fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:'synthetic-stored-only'}});
 expect(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBe('synthetic-stored-only');first.unmount();render(<App/>);await screen.findByLabelText('Quelle');
 expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0][1]?.headers).toMatchObject({Authorization:'Bearer synthetic-stored-only'});
 fireEvent.click(screen.getByRole('button',{name:'Abmelden'}));expect(screen.getByLabelText('Admin-Token')).toHaveAttribute('type','password');fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:'synthetic-again'}});fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:''}});expect(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBeNull();
});
it('logout removes the stored token and memory session',async()=>{
 responses();render(<App/>);fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:'synthetic-only'}});fireEvent.click(screen.getByRole('button',{name:'Öffnen'}));await screen.findByLabelText('Quelle');
 fireEvent.click(screen.getByRole('button',{name:'Abmelden'}));expect(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBeNull();expect(screen.getByLabelText('Admin-Token')).toHaveValue('');
});
it('storage read/write errors do not prevent login or clearing the field',async()=>{
 const transport=responses();vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('Storage blocked');});vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage blocked');});vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('Storage blocked');});
 render(<App/>);expect(screen.getByLabelText('Admin-Token')).toHaveValue('');fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:'synthetic-only'}});fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:''}});fireEvent.change(screen.getByLabelText('Admin-Token'),{target:{value:'synthetic-only'}});
 fireEvent.click(screen.getByRole('button',{name:'Öffnen'}));await screen.findByLabelText('Quelle');expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0][1]?.headers).toMatchObject({Authorization:'Bearer synthetic-only'});
 fireEvent.click(screen.getByRole('button',{name:'Abmelden'}));expect(screen.getByLabelText('Admin-Token')).toHaveValue('');
});

it('rejects an invalid saved token once and returns to masked login without demo controls',async()=>{
 localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY,'synthetic-invalid');const transport=vi.fn(async()=>Response.json({error:'Admin-Token ungültig.'},{status:401}));vi.stubGlobal('fetch',transport);render(<App/>);
 await screen.findByRole('alert');expect(transport).toHaveBeenCalledTimes(1);expect(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBeNull();expect(screen.getByLabelText('Admin-Token')).toHaveAttribute('type','password');expect(screen.queryByRole('button',{name:'Demo'})).not.toBeInTheDocument();
});
it('does not discard a saved token on transient auto-login network failures',async()=>{
 localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY,'synthetic-offline');const transport=vi.fn(async()=>{throw Error('Offline');});vi.stubGlobal('fetch',transport);render(<App/>);await screen.findByRole('alert');expect(transport).toHaveBeenCalledTimes(1);expect(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBe('synthetic-offline');
});
it('shows OAuth and missing target calendar as separate configuration statuses',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({sources:[SOURCE],statuses:{},writesEnabled:true,oauthConfigured:true,calendarConfigured:false,ephemeral:true,demo:false})));render(<App/>);loginSynthetic();await screen.findByText('OAuth eingerichtet');expect(screen.getByText('Zielkalender fehlt')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Synchronisieren'})).toBeDisabled();
});

it('loads calendars on demand, disables readonly targets and saves a per-source selection',async()=>{
 const state={sources:[SOURCE],statuses:{},writesEnabled:false,oauthConfigured:true,calendarConfigured:false,defaultCalendarId:'',ephemeral:true,demo:false};
 const transport=vi.fn(async(url:any,options:RequestInit={})=>{if(String(url).endsWith('/state'))return Response.json(state);if(String(url).endsWith('/calendars'))return Response.json({calendars:[{id:'A',summary:'Writable',writable:true},{id:'R',summary:'Readonly',writable:false}]});if(options.method==='PUT'){state.sources[0]={...SOURCE,...JSON.parse(options.body as string)};return Response.json({ok:true});}return Response.json({error:'Unexpected'},{status:400});});
 vi.stubGlobal('fetch',transport);render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');fireEvent.click(screen.getByRole('button',{name:'Einstellungen'}));expect(transport.mock.calls.some(([u])=>String(u).endsWith('/calendars'))).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Kalender laden'}));await screen.findAllByRole('option',{name:'Writable'});const select=screen.getByLabelText('Zielkalender dieser Quelle');expect(select.querySelector('option[value="R"]')).toBeDisabled();fireEvent.change(select,{target:{value:'A'}});fireEvent.click(screen.getByRole('button',{name:'Speichern'}));await waitFor(()=>expect(transport.mock.calls.some(([,o])=>o?.method==='PUT'&&JSON.parse(o.body as string).calendarId==='A')).toBe(true));
 expect(screen.getByRole('button',{name:'Synchronisieren'})).toBeDisabled();
});
it('shows missing list grant without retry or an automatic OAuth action',async()=>{
 const transport=vi.fn(async(url:any)=>String(url).endsWith('/state')?Response.json({sources:[SOURCE],statuses:{},writesEnabled:false,oauthConfigured:true,ephemeral:true,demo:false}):Response.json({error:'Kalenderliste nicht freigegeben.',requiredScope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly'},{status:403}));vi.stubGlobal('fetch',transport);render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');fireEvent.click(screen.getByRole('button',{name:'Einstellungen'}));fireEvent.click(screen.getByRole('button',{name:'Kalender laden'}));await screen.findByText('Kalenderliste nicht freigegeben.');expect(screen.getByText('https://www.googleapis.com/auth/calendar.calendarlist.readonly')).toBeInTheDocument();expect(transport).toHaveBeenCalledTimes(2);
});

it('edits and reorders transforms without changing the live configuration before save',async()=>{
 const transport=responses();render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');fireEvent.click(screen.getByRole('button',{name:'Einstellungen'}));
 fireEvent.change(screen.getByLabelText('Ort einschließen (RegEx)'),{target:{value:'Berlin'}});
 fireEvent.click(screen.getByRole('button',{name:'Transform hinzufügen'}));fireEvent.change(screen.getByLabelText('Transform 1 Muster'),{target:{value:'PRIVATE'}});fireEvent.change(screen.getByLabelText('Transform 1 Ersetzung'),{target:{value:'Public'}});
 fireEvent.click(screen.getByRole('button',{name:'Transform hinzufügen'}));fireEvent.change(screen.getByLabelText('Transform 2 Feld'),{target:{value:'location'}});fireEvent.change(screen.getByLabelText('Transform 2 Muster'),{target:{value:'Berlin'}});
 fireEvent.click(screen.getAllByRole('button',{name:'Nach oben'})[1]);expect(screen.getByLabelText('Transform 1 Feld')).toHaveValue('location');expect(screen.getByLabelText('Transform 2 Muster')).toHaveValue('PRIVATE');
 fireEvent.click(screen.getAllByRole('button',{name:'Entfernen'})[0]);expect(screen.getByLabelText('Transform 1 Muster')).toHaveValue('PRIVATE');expect(screen.queryByLabelText('Transform 2 Muster')).not.toBeInTheDocument();
 expect(transport.mock.calls.some(([,options])=>options?.method==='PUT')).toBe(false);expect(screen.getByText(/Ersetzung:.*\$1/)).toHaveTextContent('$1, $2, $&, $<name>; $$');
});

it('shows count-only progress, cooldown and finite-retry pause',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>Response.json({sources:[SOURCE],statuses:{[SID]:{ok:false,at:'2026-10-04T12:00:00Z',mode:'sync',error:'Google-Rate-Limit',retryAt:'2026-10-04T12:10:00Z',automaticPaused:true,progress:{fetched:42,changed:2,skipped:39,written:1,pending:2,confirmedEarlier:1,resuming:true}}},writesEnabled:false,oauthConfigured:false,ephemeral:true,demo:true})));render(<App/>);loginSynthetic();await screen.findByText(/42 abgerufen · 2 Änderungen · 39 unverändert · 1 geschrieben · 2 offen · Wiederaufnahme/);expect(screen.getByText(/Rate-Limit-Pause bis/)).toBeInTheDocument();expect(screen.getByText(/Automatik pausiert/)).toBeInTheDocument();});
it('folder snapshot and cleanup controls are explicit opt-ins and remain editable',async()=>{const state={sources:[{...SOURCE,kind:'folder',location:'.'}],statuses:{},writesEnabled:false,oauthConfigured:false,ephemeral:true,demo:true};vi.stubGlobal('fetch',vi.fn(async()=>Response.json(state)));render(<App/>);loginSynthetic();await screen.findByLabelText('Quelle');fireEvent.click(screen.getByRole('button',{name:'Einstellungen'}));expect(screen.getByLabelText('Ordnerbetrieb')).toHaveValue('aggregate');expect(screen.getByLabelText('Dateibehandlung')).toHaveValue('keep');fireEvent.change(screen.getByLabelText('Ordnerbetrieb'),{target:{value:'snapshot'}});expect(screen.getByLabelText('Snapshot-Dateiname')).toBeRequired();expect(screen.getByLabelText('Exportumfang')).toHaveValue('unknown');fireEvent.change(screen.getByLabelText('Exportumfang'),{target:{value:'window'}});expect(screen.getByLabelText('Fensterende (exklusiv)')).toBeRequired();fireEvent.change(screen.getByLabelText('Dateibehandlung'),{target:{value:'delete'}});expect(screen.getByLabelText(/Der Exporter veröffentlicht/)).not.toBeChecked();expect(screen.getByLabelText(/Der Exporter veröffentlicht/)).toBeRequired();});
