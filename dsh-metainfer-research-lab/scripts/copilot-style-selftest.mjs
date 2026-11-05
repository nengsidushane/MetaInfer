/** Tests actual emitted plugin CSS; not runtime GPU/performance acceptance. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
let definition;
const context = {window:{__ModuleLoader__:{load(value){definition=value;}}},__test:{},console,localStorage:{getItem(){return null;},setItem(){}}};
const instrumented = source.replace('function LabStyle() {','__test.style = LabStyle; function LabStyle() {');
assert.notEqual(instrumented, source);
vm.runInNewContext(instrumented,context,{filename:'client.js'});
definition.factory(() => ({Component:class {},memo:component=>component,createElement:(type,props,...children)=>({type,props,children})}));
const style = context.__test.style();
assert.equal(style.type,'style');
const css = style.children[0];
const outerRules = [...css.matchAll(/\.rl-copilot-native\s*\{([^}]*)\}/g)].map(match=>match[1]);
test('desktop Copilot keeps a rectangular outer clipping surface',()=>{
 assert.ok(outerRules.length>=2);
 assert.match(outerRules[0],/border-radius:\s*0(?:px)?\s*;/);
 assert.match(outerRules[0],/overflow:\s*hidden\s*;/);
});
test('mobile Copilot does not reintroduce the large rounded clip',()=>{
 assert.match(outerRules.at(-1),/border-radius:\s*0(?:px)?\s*;/);
});
test('outer sizing and inner scroll containment stay in place',()=>{
 assert.match(outerRules[0],/max-width:\s*calc\(100vw - 32px\)/);
 assert.match(outerRules[0],/max-height:\s*calc\(100vh - 32px\)/);
 assert.match(css,/\.rl-copilot-native-body\s*\{[^}]*overflow:\s*hidden/);
 assert.match(css,/\.rl-copilot-native-view\s*\{[^}]*overflow:\s*hidden/);
 assert.match(css,/\.rl-copilot-native-view \[data-conversation-scroll\]\s*\{[^}]*overflow-y:\s*auto !important/);
});
test('native composer remains present in the emitted embedded layout rules',()=>{
 assert.match(css,/\.rl-copilot-native-view \[data-composer-seat\]/);
 assert.match(css,/\.rl-copilot-native-view > \[data-conversation-content\]/);
});
