import {DateTime} from 'luxon';
import {it,expect} from 'vitest';
import {parseCalendar} from '../server/calendar';
import {preserveClippedSeries} from '../server/clipped-series';
import {windowOccurrences} from '../server/window-recurrence';
import {syncPlan} from '../server/google';
import {sourceSchema} from '../shared/contracts';
import {ics,SOURCE,SID,FakeGoogle} from './fixtures';
const source=sourceSchema.parse({...SOURCE,kind:'folder',calendarId:'invented-output',folderMode:'snapshot',snapshotFile:'fiction.ics',clipSeriesMode:'window-reconcile',snapshotClip:{completeExportConfirmed:true,boundary:'protect-boundary',ordering:'manual-confirm'}});
const master='UID:invented-solar@example.invalid\r\nDTSTART;TZID=Europe/Berlin:20440201T074500\r\nDTEND;TZID=Europe/Berlin:20440201T083000\r\nRRULE:FREQ=MONTHLY;COUNT=8;BYDAY=1MO\r\nSUMMARY:Invented solar workshop';
function fixture(){const original=parseCalendar(ics([master]),SID,{},source.calendarId),p=parseCalendar(ics([master.replaceAll('20440201','20440307').replaceAll('T074500','T092000').replaceAll('T083000','T104000').replace('COUNT=8','COUNT=7')]),SID,{},source.calendarId);p.clipWindow={start:'2044-03-01T00:00:00.000Z',end:'2044-05-01T00:00:00.000Z'};const i=original.items[0]!;return {p,target:{id:i.key,...i.event!,etag:'invented-etag'}};}
it('reconciles monthly clock and duration changes without changing master times or outside occurrences',async()=>{
 const {p,target}=fixture(),plan=preserveClippedSeries(p,source,[target]),root=plan.items.find(i=>!i.parent)!;
 expect(root.event!.start).toEqual(target.start);expect(root.event!.end).toEqual(target.end);expect(root.event!.recurrence?.[0]).toBe(target.recurrence![0]);expect(root.clipSeriesEtag).toBe('invented-etag');
 const inside=plan.items.filter(i=>i.parent);expect(inside).toHaveLength(2);expect(inside[0].event!.start.dateTime).toContain('09:20:00');expect(Date.parse(inside[0].event!.end.dateTime!)-Date.parse(inside[0].event!.start.dateTime!)).toBe(80*60000);
 const old=windowOccurrences(target,Date.parse('2044-12-01T00:00:00Z')).effective,next=windowOccurrences(root.event!,Date.parse('2044-12-01T00:00:00Z')).effective;
 const outside=(ms:number)=>ms<Date.parse(p.clipWindow!.start)||ms>=Date.parse(p.clipWindow!.end);expect(next.filter(outside)).toEqual(old.filter(outside));
 const g=new FakeGoogle();g.events.set(target.id,target);await syncPlan(plan,source,g);expect(g.calls[0].method).toBe('PATCH');expect(g.calls[0].body.start).toBeUndefined();expect(g.calls.filter(c=>c.method==='PUT')).toHaveLength(2);
 const again=preserveClippedSeries(p,source,[...g.events.values()]);const count=g.calls.length;await syncPlan(again,source,g);expect(g.calls).toHaveLength(count);
});
it('suppresses a missing owned series only inside the snapshot window',()=>{const {p,target}=fixture();p.items=[];const plan=preserveClippedSeries(p,source,[target]);const old=windowOccurrences(target,Date.parse('2044-12-01T00:00:00Z')).effective,next=windowOccurrences(plan.items[0].event!,Date.parse('2044-12-01T00:00:00Z')).effective;expect(next.length).toBe(old.length-2);expect(next.every(ms=>ms<Date.parse(p.clipWindow!.start)||ms>=Date.parse(p.clipWindow!.end))).toBe(true);});
it('bounds newly introduced series to this window, then repeats without writes',async()=>{const {p}=fixture(),plan=preserveClippedSeries(p,source,[]),root=plan.items.find(i=>!i.parent)!;expect(root.event!.recurrence).toHaveLength(1);expect(root.event!.recurrence![0]).toMatch(/^RDATE:/);const g=new FakeGoogle();await syncPlan(plan,source,g);const count=g.calls.length;await syncPlan(preserveClippedSeries(p,source,[...g.events.values()]),source,g);expect(g.calls).toHaveLength(count);});
it('retains explicit exception time and duration instead of restoring the base slot',()=>{const {p,target}=fixture();const child='UID:invented-solar@example.invalid\r\nRECURRENCE-ID;TZID=Europe/Berlin:20440307T092000\r\nDTSTART;TZID=Europe/Berlin:20440309T113000\r\nDURATION:PT25M';const parsed=parseCalendar(ics([master.replaceAll('20440201','20440307').replaceAll('T074500','T092000').replaceAll('T083000','T104000').replace('COUNT=8','COUNT=7'),child]),SID,{},source.calendarId);parsed.clipWindow=p.clipWindow;const plan=preserveClippedSeries(parsed,source,[target]);const moved=plan.items.find(i=>i.parent&&i.event!.start.dateTime?.includes('2044-03-09'))!;expect(moved).toBeTruthy();expect(Date.parse(moved.event!.end.dateTime!)-Date.parse(moved.event!.start.dateTime!)).toBe(25*60000);});
it('stops before writes on foreign ownership, changed migration ETags and boundary-crossing overrides',async()=>{const {p,target}=fixture();expect(()=>preserveClippedSeries(p,source,[{...target,extendedProperties:{private:{...target.extendedProperties.private,source:'foreign'}}}])).toThrow();const plan=preserveClippedSeries(p,source,[target]),g=new FakeGoogle();g.events.set(target.id,{...target,etag:'drift'});await expect(syncPlan(plan,source,g)).rejects.toThrow();expect(g.calls).toEqual([]);
 const ms=Date.parse('2044-03-07T08:20:00Z'),oldChild={id:'invented-child',recurringEventId:target.id,etag:'child',originalStartTime:{dateTime:new Date(ms).toISOString(),timeZone:'UTC'},start:{dateTime:'2044-05-01T12:00:00Z',timeZone:'UTC'},end:{dateTime:'2044-05-01T13:00:00Z',timeZone:'UTC'},extendedProperties:{private:{...target.extendedProperties.private,key:'invented-child'}}};expect(()=>preserveClippedSeries(p,source,[target,oldChild])).toThrow();});
it('expands daily, monthly ordinal and yearly rules with bounded UTC UNTIL and DST-safe local time',()=>{for(const rule of ['FREQ=DAILY;COUNT=3','FREQ=MONTHLY;COUNT=3;BYDAY=1MO','FREQ=YEARLY;COUNT=3']){const result=windowOccurrences({start:{dateTime:'2044-02-01T07:45:00+01:00',timeZone:'Europe/Berlin'},recurrence:['RRULE:'+rule]},Date.parse('2047-01-01T00:00:00Z'));expect(result.effective).toHaveLength(3);}expect(windowOccurrences({start:{dateTime:'2044-03-25T07:45:00+01:00',timeZone:'Europe/Berlin'},recurrence:['RRULE:FREQ=DAILY;UNTIL=20440328T054500Z']},Date.parse('2044-04-01T00:00:00Z')).effective.length).toBe(4);});

it('cancels obsolete owned overrides within the window and binds their ETags before writes',async()=>{
 const {p,target}=fixture();const current={id:'invented-override',recurringEventId:target.id,etag:'invented-instance-etag',originalStartTime:{dateTime:'2044-03-07T06:45:00Z',timeZone:'UTC'},start:{dateTime:'2044-03-09T11:30:00Z',timeZone:'UTC'},end:{dateTime:'2044-03-09T12:10:00Z',timeZone:'UTC'},status:'confirmed',extendedProperties:{private:{...target.extendedProperties.private,key:'inventedoverridekey'}}};
 const plan=preserveClippedSeries(p,source,[target,current]),cancel=plan.items.find(i=>i.cancel)!;expect(cancel.approvedCancelEtag).toBe(current.etag);const g=new FakeGoogle();g.events.set(target.id,target);g.events.set(current.id,current);await syncPlan(plan,source,g);expect(g.events.get(current.id)?.status).toBe('cancelled');
 const changed=new FakeGoogle();changed.events.set(target.id,target);changed.events.set(current.id,{...current,etag:'changed'});await expect(syncPlan(plan,source,changed)).rejects.toThrow('Fensterinstanz');expect(changed.calls).toEqual([]);
});
it('stops when a desired occurrence touches a protected boundary rather than erasing a shorter old slot',()=>{const {p,target}=fixture();p.clipWindow!.end='2044-03-07T09:40:00.000Z';expect(()=>preserveClippedSeries(p,source,[target])).toThrow();});
it('rejects DST ambiguity, unsupported high-frequency rules and excessive horizons',()=>{
 expect(()=>windowOccurrences({start:{dateTime:'2044-02-01T07:45:00Z',timeZone:'UTC'},recurrence:['RRULE:FREQ=MINUTELY;COUNT=3']},Date.parse('2044-03-01T00:00:00Z'))).toThrow();
 expect(()=>windowOccurrences({start:{dateTime:'1900-01-01T07:45:00Z',timeZone:'UTC'},recurrence:['RRULE:FREQ=DAILY']},Date.parse('2044-03-01T00:00:00Z'))).toThrow();
 const ambiguous=Date.parse('2044-10-30T00:30:00Z'); // Last Sunday in October, independent synthetic dates.
 expect(()=>windowOccurrences({start:{dateTime:new Date(ambiguous).toISOString(),timeZone:'Europe/Berlin'},recurrence:['RRULE:FREQ=DAILY;COUNT=2']},ambiguous+86400000)).toThrow();
});
it('does not silently discard an obsolete override with only inherited parent ownership',()=>{const {p,target}=fixture();const current={id:'invented-inherited-instance',recurringEventId:target.id,originalStartTime:{dateTime:'2044-03-07T06:45:00Z',timeZone:'UTC'},start:{dateTime:'2044-03-09T11:00:00Z',timeZone:'UTC'},end:{dateTime:'2044-03-09T11:40:00Z',timeZone:'UTC'},etag:'invented-inherited-etag',extendedProperties:{private:target.extendedProperties.private}};expect(()=>preserveClippedSeries(p,source,[target,current])).toThrow();});
it('keeps a newly introduced master anchored to the original slot when its first occurrence is moved',()=>{const {p}=fixture();const child='UID:invented-solar@example.invalid\r\nRECURRENCE-ID:20440307T082000Z\r\nDTSTART:20440309T113000Z\r\nDTEND:20440309T115500Z';const incoming=master.replaceAll('20440201','20440307').replaceAll('T074500','T092000').replaceAll('T083000','T104000').replace('COUNT=8','COUNT=7');const plan=parseCalendar(ics([incoming,child]),SID,{},source.calendarId);plan.clipWindow=p.clipWindow;const normalized=preserveClippedSeries(plan,source,[]),root=normalized.items.find(i=>!i.parent)!;expect(Date.parse(root.event!.start.dateTime!)).toBe(Date.parse('2044-03-07T08:20:00Z'));expect(root.event!.extendedProperties.private.key).toBe(root.key);expect(windowOccurrences(root.event!,Date.parse(p.clipWindow!.end)).effective).toHaveLength(2);expect(normalized.items.some(i=>i.parent&&i.event?.start.dateTime?.includes('2044-03-09T11:30:00'))).toBe(true);});

it('retains equivalent Google-normalized RDATE/EXDATE lines without repeated master writes',async()=>{
 const {p,target}=fixture(),g=new FakeGoogle();g.events.set(target.id,target);
 await syncPlan(preserveClippedSeries(p,source,[target]),source,g);
 const current=g.events.get(target.id)!;
 current.recurrence=current.recurrence!.flatMap(line=>{
  const match=/^(RDATE|EXDATE):(.+)$/.exec(line);if(!match)return [line];
  return match[2].split(',').reverse().map(value=>match[1]+';TZID=Europe/Berlin:'+DateTime.fromFormat(value,"yyyyMMdd'T'HHmmss'Z'",{zone:'UTC'}).setZone('Europe/Berlin').toFormat("yyyyMMdd'T'HHmmss"));
 });
 const serverRecurrence=structuredClone(current.recurrence);
 const repeated=preserveClippedSeries(p,source,[...g.events.values()]);
 expect(repeated.items.find(i=>!i.parent)!.event!.recurrence).toEqual(serverRecurrence);
 const before=g.calls.length;
 const result=await syncPlan(repeated,source,g);
 expect(result.upserted).toBe(0);expect(g.calls).toHaveLength(before);
 // A real clock change still requires a scoped migration, not normalization.
 const changed=structuredClone(p),incoming=changed.items.find(i=>!i.parent)!.event!;
 incoming.start={dateTime:DateTime.fromISO(incoming.start.dateTime!).plus({minutes:5}).toISO()!,timeZone:'Europe/Berlin'};
 incoming.end={dateTime:DateTime.fromISO(incoming.end.dateTime!).plus({minutes:5}).toISO()!,timeZone:'Europe/Berlin'};
 const next=preserveClippedSeries(changed,source,[...g.events.values()]);
 expect(next.items.find(i=>!i.parent)!.clipSeriesEtag).toBeTruthy();
});
