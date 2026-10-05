import {DateTime} from 'luxon';
import {AppError} from './errors.js';
import type {Plan,Source} from '../shared/contracts.js';
import type {SnapshotScope} from './snapshot-preview.js';
export interface ClipWindow {start:string;end:string}
export function clipInstant(raw:string){if(!/^\d{8}T\d{6}Z$/.test(raw))throw new AppError('Clip-Grenze benötigt eindeutige UTC-DATE-TIME.');const dt=DateTime.fromFormat(raw,"yyyyMMdd'T'HHmmss'Z'",{zone:'UTC'});if(!dt.isValid||dt.toFormat("yyyyMMdd'T'HHmmss'Z'")!==raw)throw new AppError('Clip-Grenze ungültig.');return dt.toISO()!;}
export function clipScope(plan:Plan,source:Source):SnapshotScope {if(!source.snapshotClip)return source.snapshotScope??{authority:'unknown'};if(!plan.clipWindow)throw new AppError('Clip-Modus benötigt beide eindeutigen VCALENDAR-Clip-Grenzen.');return source.snapshotClip.completeExportConfirmed?{authority:'window',basis:'clip',boundary:source.snapshotClip.boundary,window:{...plan.clipWindow,timezone:source.rules.floatingTimezone}}:{authority:'unknown'};}
