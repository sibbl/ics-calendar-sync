import {createApp} from './app.js';import {demoConfig,DEMO_ID,SYNTHETIC_ICS}from'./fixtures.js';
const {runtime}=createApp(demoConfig());runtime.uploads.set(DEMO_ID,new TextEncoder().encode(SYNTHETIC_ICS));try{console.log(JSON.stringify(await runtime.execute(DEMO_ID),null,2));}finally{await runtime.close();}
