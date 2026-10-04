// A supplied pseudonym list may already convey the same accepted count.
// Current calendar bodies omit attendee identities; callers with such a list can avoid duplication.
export function anonymousTitle(showCount:boolean,count:number|undefined,pseudonymizedParticipants?:readonly string[]){
 const represented=count!==undefined&&!!pseudonymizedParticipants?.length&&pseudonymizedParticipants.length===count;
 return 'Termin'+(showCount&&count!==undefined&&!represented?` · ${count} 👤`:'');
}
