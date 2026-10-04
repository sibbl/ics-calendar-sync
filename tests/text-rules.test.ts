import {it,expect} from 'vitest';
import {parseCalendar} from '../server/calendar';
import {configuredSources} from '../server/config';
import {compileTextRules} from '../server/text-rules';
import {googleSourcePlan} from '../server/google-source';
import {exportConfiguration} from '../server/env-export';
import {sourceSchema,rulesSchema} from '../shared/contracts';
import {BASE,ics,SID} from './fixtures';
const parse=(rule:object={},event=BASE+'\r\nLOCATION:Berlin Raum 7')=>parseCalendar(ics([event]),SID,rule);
const rule=(field:'title'|'location',pattern:string,replacement:string,flags='iu')=>({field,pattern,replacement,flags});
it('includes original locations and exclusion wins overlap',()=>{expect(parse({locationIncludeRegex:'Berlin',locationExcludeRegex:'Raum 7'}).items[0].cancel).toBe(true);expect(parse({locationIncludeRegex:'Berlin',locationExcludeRegex:'Paris'}).items[0].cancel).toBe(false);expect(parse({locationIncludeRegex:'Paris'}).items[0].cancel).toBe(true);});
it('treats absent and explicitly empty location as empty string',()=>{expect(parse({locationIncludeRegex:'^$'},BASE).items[0].cancel).toBe(false);expect(parse({locationExcludeRegex:'^$'},BASE+'\r\nLOCATION:').items[0].cancel).toBe(true);});
it('applies original title exclusion before transforms',()=>expect(parse({excludeRegex:'PRIVATE',transforms:[rule('title','.*','Visible')]}).items[0].cancel).toBe(true));
it('applies original location inclusion before transforms',()=>expect(parse({locationIncludeRegex:'Paris',transforms:[rule('location','Berlin','Paris')]}).items[0].cancel).toBe(true));
it('first match consumes the entire array across fields',()=>{const e=parse({includeLocation:true,transforms:[rule('title','PRIVATE','Public'),rule('location','Berlin','Paris')]}).items[0].event!;expect(e.summary).toBe('Public synthetic title');expect(e.location).toBe('Berlin Raum 7');});
it('location match prevents later title transform',()=>{const e=parse({includeLocation:true,transforms:[rule('location','Berlin','Paris'),rule('title','PRIVATE','Public')]}).items[0].event!;expect(e.summary).toBe('Termin');expect(e.location).toBe('Paris Raum 7');});
it('no-op first match consumes and replacement never cascades',()=>{expect(parse({transforms:[rule('title','PRIVATE','PRIVATE'),rule('title','PRIVATE','Public')]}).items[0].event!.summary).toBe('PRIVATE synthetic title');expect(parse({transforms:[rule('title','PRIVATE','Step'),rule('title','Step','Final')]}).items[0].event!.summary).toBe('Step synthetic title');});
it('skips unmatched rules without exposing original title',()=>expect(parse({transforms:[rule('title','^absent$','No')]}).items[0].event!.summary).toBe('Termin'));
it('supports numbered, named, matched-text and literal-dollar replacement',()=>{const e=parse({transforms:[rule('title','(?<secret>PRIVATE) (synthetic)','$2 / $<secret> / $$ / $&')]}).items[0].event!;expect(e.summary).toBe('synthetic / PRIVATE / $ / PRIVATE synthetic title');});
it('supports Unicode and global replacement within one rule',()=>{const e=parse({transforms:[rule('title','ä','ö','giu')]},BASE.replace('PRIVATE synthetic title','Ää')).items[0].event!;expect(e.summary).toBe('öö');});
it('keeps location private when copying is disabled, including transform output',()=>expect(parse({transforms:[rule('location','Berlin','Secret mapping')]}).items[0].event).not.toHaveProperty('location'));
it('preserves accepted-count title format',()=>expect(parse({acceptedCount:true,transforms:[rule('title','^.*$','Mapped')]},BASE+'\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:synthetic@example.invalid').items[0].event!.summary).toBe('Mapped · 1 👤'));
it('rejects invalid syntax, unsupported lookarounds, backreferences and duplicate flags',()=>{for(const transform of [rule('title','[','x'),rule('title','(?=PRIVATE)','x'),rule('title','(a)\\1','x'),rule('title','a','x','ii')])expect(()=>parse({transforms:[transform]})).toThrow();});
it('runs nested repetition safely with RE2',()=>{const rules=compileTextRules(rulesSchema.parse({transforms:[rule('title','(a+)+$','x')]}));expect(rules.transform('a'.repeat(500000)+'!', '').title).toBeUndefined();});
it('validates invalid rules at configuration acceptance',()=>expect(()=>configuredSources(JSON.stringify([{id:SID,name:'Synthetic',kind:'upload',rules:{locationIncludeRegex:'['}}]))).toThrow());
it('roundtrips filters and ordered transforms through ENV for every source kind',()=>{for(const kind of ['upload','file','folder','url','google']){const s=sourceSchema.parse({id:SID,name:'Synthetic',kind,sourceCalendarId:kind==='google'?'synthetic-input':undefined,rules:{locationIncludeRegex:'Berlin',locationExcludeRegex:'Paris',transforms:[rule('location','Berlin','Remote'),rule('title','PRIVATE','Public')]}});expect(configuredSources(exportConfiguration([s],'').SOURCES_JSON)[0].rules).toEqual(s.rules);}});
it('Google sources use the same original filters and transforms',()=>{const s=sourceSchema.parse({id:SID,name:'Synthetic',kind:'google',sourceCalendarId:'synthetic-input',rules:{busyMode:'all',includeLocation:true,locationIncludeRegex:'Berlin',transforms:[rule('location','Berlin','Remote')]}});const p=googleSourcePlan([{id:'synthetic',summary:'Private',location:'Berlin',start:{dateTime:'2026-03-23T08:00:00Z',timeZone:'UTC'},end:{dateTime:'2026-03-23T09:00:00Z',timeZone:'UTC'}}],s);expect(p.items[0].event?.location).toBe('Remote');expect(p.items[0].event?.summary).toBe('Termin');});

it('bounds matching transform input and expanded output without truncation',()=>{expect(()=>compileTextRules(rulesSchema.parse({transforms:[rule('title','a','x','gu')]})).transform('a'.repeat(4097),'')).toThrow(/Originaltext/);expect(()=>compileTextRules(rulesSchema.parse({transforms:[rule('title','a','xx','gu')]})).transform('a'.repeat(3000),'')).toThrow(/Ergebnis/);});
it('applies shared rules through upload, file, folder and URL loaders',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {loadSource}=await import('../server/sources');
 const root=await mkdtemp(join(tmpdir(),'text-rules-'));try{const data=ics([BASE+'\r\nLOCATION:Berlin']);await writeFile(join(root,'synthetic.ics'),data);
 for(const kind of ['upload','file','folder','url'] as const){const s=sourceSchema.parse({id:SID,name:'Synthetic',kind,location:kind==='file'?'synthetic.ics':kind==='url'?'https://synthetic.invalid':'',rules:{locationIncludeRegex:'Berlin',includeLocation:true,transforms:[rule('location','Berlin','Mapped')]}});const p=await loadSource(s,root,new Map([[SID,data]]),async()=>data);expect(p.items[0].event?.location).toBe('Mapped');expect(p.items[0].event?.summary).toBe('Termin');}
 }finally{await rm(root,{recursive:true,force:true});}
});
