export const ADMIN_TOKEN_STORAGE_KEY = 'ics-google-calendar-sync.admin-token.v1';
export function readAdminToken(): string {
 try {return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';} catch {return '';}
}
export function persistAdminToken(value:string): void {
 try {
  if(value) window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY,value);
  else window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
 }catch {/* Login remains usable in memory if browser storage is unavailable. */}
}
