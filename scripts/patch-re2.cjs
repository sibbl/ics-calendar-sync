// re2-wasm 1.0.2 omits native handle disposal. Keep this version-specific fix
// deterministic for host and both Docker npm-ci stages; fail on upstream drift.
const fs=require('node:fs');
const path=require('node:path');
const root=path.dirname(require.resolve('re2-wasm/package.json'));
if(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version!=='1.0.2')throw Error('Review RE2 lifetime patch for dependency version.');
const js=path.join(root,'build/src/re2.js'),types=path.join(root,'build/src/re2.d.ts');
let code=fs.readFileSync(js,'utf8');
if(!code.includes('/* app-managed-native-lifetime */')){
 const start=code.indexOf('        if (!this.wrapper.ok()) {');
 const end=code.indexOf('\n    }\n    get source()',start);
 if(start<0||end<0)throw Error('Unexpected RE2 constructor; lifetime patch not applied.');
 let body=code.slice(start,end);
 if(!body.includes('const groupNames = this.wrapper.capturingGroupNames();')||!body.includes('const groupNumbers = groupNames.keys();'))throw Error('Unexpected RE2 native capture handles.');
 body=body.replace('const groupNames =','groupNames =').replace('const groupNumbers =','groupNumbers =');
 code=code.slice(0,start)+'        /* app-managed-native-lifetime */\n        let groupNames, groupNumbers;\n        try {\n'+body+'\n        } catch (error) { this.wrapper.delete(); throw error; }\n        finally { groupNumbers?.delete(); groupNames?.delete(); }'+code.slice(end);
 code=code.replace('    get source() {','    dispose() { this.wrapper.delete(); }\n    get source() {');
 fs.writeFileSync(js,code);
}
let declaration=fs.readFileSync(types,'utf8');
if(!declaration.includes('    dispose(): void;')){
 if(!declaration.includes('    get source(): string;'))throw Error('Unexpected RE2 declaration.');
 declaration=declaration.replace('    get source(): string;','    dispose(): void;\n    get source(): string;');fs.writeFileSync(types,declaration);
}
