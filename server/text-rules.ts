import {RE2} from 're2-wasm';
import type {Rules} from '../shared/contracts.js';
import {AppError} from './errors.js';
// Parsing is synchronous and a source uses at most 35 expressions. The bounded
// cache avoids recompilation per Google group and frees evicted native handles.
const cache=new Map<string,RE2>();
export function expression(pattern:string,flags='iu'){
 try{if(!/^[gimsu]*$/.test(flags)||new Set(flags).size!==flags.length)throw new SyntaxError();
  const normalized=[...new Set(flags+'u')].sort().join(''),key=JSON.stringify([pattern,normalized]);let regex=cache.get(key);
  if(regex){cache.delete(key);cache.set(key,regex);regex.lastIndex=0;return regex;}
  if(cache.size>=128){const oldest=cache.keys().next().value!;cache.get(oldest)!.dispose();cache.delete(oldest);}
  regex=new RE2(pattern,normalized);cache.set(key,regex);return regex;
 }
 catch(error){if(!(error instanceof SyntaxError))throw new AppError('RegEx-Engine nicht verfügbar; Verarbeitung gestoppt. Keine ENV-Migration erforderlich.');throw new AppError('RegEx ungültig. RE2 unterstützt keine Rückverweise oder Lookarounds; Flags: g, i, m, s, u.');}
}
export function compileTextRules(rules:Rules){
 const include=rules.locationIncludeRegex?expression(rules.locationIncludeRegex,rules.locationRegexFlags??'iu'):undefined;
 const exclude=rules.locationExcludeRegex?expression(rules.locationExcludeRegex,rules.locationRegexFlags??'iu'):undefined;
 const transforms=(rules.transforms??[]).map(rule=>({...rule,regex:expression(rule.pattern,rule.flags)}));
 function match(regex:RE2,text:string){regex.lastIndex=0;return regex.test(text);}
 return {
  excludesLocation:(location:string)=>!!include&&!match(include,location)||!!exclude&&match(exclude,location),
  transform:(title:string,location:string)=>{
   for(const rule of transforms){const text=rule.field==='title'?title:location;if(!match(rule.regex,text))continue;
    if(text.length>4096)throw new AppError('Originaltext für Transform größer als 4096 Zeichen; Quelle übersprungen.');
    rule.regex.lastIndex=0;const replacement=rule.regex.replace(text,rule.replacement);
    if(replacement.length>4096)throw new AppError('Transform-Ergebnis größer als 4096 Zeichen; Quelle übersprungen.');
    return rule.field==='title'?{title:replacement,location}:{location:replacement};
   }
   return {location};
  }
 };
}
