import {it,expect} from 'vitest';
import {sameRecurrence,sameSeriesZone} from '../server/series-structure';
import {syncPlan} from '../server/google';
import {parseCalendar} from '../server/calendar';
import {ics,MASTER,SID,SOURCE,FakeGoogle} from './fixtures';
it('equates reordered RRULE parts, lists and explicit defaults',()=>expect(sameRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'],['RRULE:WKST=MO;BYDAY=WE,MO;INTERVAL=1;FREQ=WEEKLY'])).toBe(true));
it('preserves actual count, until, interval and weekday differences',()=>{for(const rule of ['COUNT=3','UNTIL=20260101T000000Z','INTERVAL=2','BYDAY=TU'])expect(sameRecurrence(['RRULE:FREQ=WEEKLY'],['RRULE:FREQ=WEEKLY;'+rule])).toBe(false);});
it('equates canonical timezone aliases but preserves recurrence timezone',()=>{expect(sameSeriesZone({dateTime:'2026-01-01T08:00:00Z',timeZone:'Etc/UTC'},{dateTime:'2026-01-01T08:00:00Z',timeZone:'UTC'})).toBe(true);expect(sameSeriesZone({dateTime:'2026-01-01T08:00:00Z',timeZone:'UTC'},{dateTime:'2026-01-01T08:00:00Z',timeZone:'Europe/London'})).toBe(false);});
it('accepts remote normalization and keeps structure out of PATCH',async()=>{const p=parseCalendar(ics([MASTER]),SID),g=new FakeGoogle();await syncPlan(p,SOURCE,g);const e=g.events.get(p.items[0].key)!;e.recurrence=e.recurrence!.map(r=>r.split(':')[0]+':'+r.split(':')[1].split(';').reverse().join(';')+';INTERVAL=1');g.calls=[];const result=await syncPlan(p,SOURCE,g);expect(result.unchanged).toBe(1);expect(g.calls).toEqual([]);});
