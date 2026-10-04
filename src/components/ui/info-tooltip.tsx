import {useId, useRef, useState} from 'react';
export function InfoTooltip({label, children}:{label:string;children:string}) {
 const id=useId(), button=useRef<HTMLButtonElement>(null), [open,setOpen]=useState(false);
 return <span className="info">
  <button ref={button} type="button" className="info-button" aria-label={'Info: '+label} aria-describedby={open?id:undefined} aria-expanded={open}
   onFocus={()=>setOpen(true)} onBlur={()=>setOpen(false)} onClick={()=>setOpen(true)}
   onMouseEnter={()=>setOpen(true)} onMouseLeave={()=>{if(document.activeElement!==button.current)setOpen(false);}}
   onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);}}}>i</button>
  {open&&<span id={id} role="tooltip" className="info-tooltip">{children}</span>}
 </span>;
}
