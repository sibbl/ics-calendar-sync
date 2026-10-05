import path from 'node:path';
import type {Config} from './config.js';
import {sourceSchema} from '../shared/contracts.js';
export const DEMO_ID='00000000-0000-4000-8000-000000000001';
export const SYNTHETIC_ICS=`BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Synthetic local demo//EN\r
X-CLIPSTART:20260101T000000Z\r
X-CLIPEND:20270101T000000Z\r
BEGIN:VEVENT\r
UID:synthetic-weekly\r
DTSTART;TZID=Europe/Berlin:20261005T100000\r
DTEND;TZID=Europe/Berlin:20261005T110000\r
RRULE:FREQ=WEEKLY;COUNT=4\r
SUMMARY:Synthetic private topic\r
X-MICROSOFT-CDO-BUSYSTATUS:BUSY\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:synthetic-weekly\r
RECURRENCE-ID;TZID=Europe/Berlin:20261012T100000\r
DTSTART:20261013T120000Z\r
DTEND:20261013T130000Z\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:synthetic-lunch\r
DTSTART:20261005T100000Z\r
DTEND:20261005T103000Z\r
SUMMARY:Mittagspause\r
X-MICROSOFT-CDO-BUSYSTATUS:BUSY\r
END:VEVENT\r
END:VCALENDAR\r
`;
export function demoConfig():Config{return {adminToken:'synthetic-demo-only',clientId:'',clientSecret:'',refreshToken:'',calendarId:'',writes:false,watchRoot:path.resolve('example-sources'),sources:[sourceSchema.parse({id:DEMO_ID,name:'Synthetischer Kalender',kind:'upload'})],demo:true,port:8080,host:'127.0.0.1'};}
