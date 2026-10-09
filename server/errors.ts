export class AppError extends Error {retryAt?:number;confirmedWrites?:number;uncertainWrites?:number;retryExhausted?:boolean;quotaAttempt?:number; constructor(message:string){super(message);this.name='AppError';} }
export const MAX_BYTES=10*1024*1024;

// Revision failures need new input/configuration or explicit operator retry.
export class RevisionError extends AppError {readonly retryPolicy='revision' as const;}
