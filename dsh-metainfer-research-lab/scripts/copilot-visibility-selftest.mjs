/** Optional shipped-DSH selector integration; no live UI, agents, or model calls.
 * Set DSH_WORKSPACE_CLIENT_PATH to an unmodified shipped workspace client source.
 * Ordering/current-selection helpers are fixtures; visibility/grouping bodies are native.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

function declaration(source, name) {
 const anchor='function '+name+'(';
 const start=source.indexOf(anchor);
 assert.ok(start>=0, 'missing shipped function '+name);
 assert.equal(source.indexOf(anchor,start+anchor.length),-1,'ambiguous shipped function '+name);
 let depth=0, quote='', escaped=false, comment='';
 for(let i=source.indexOf('{',start);i<source.length;i++){
  const c=source[i], next=source[i+1];
  if(comment==='line'){if(c==='\n')comment='';continue;}
  if(comment==='block'){if(c==='*'&&next==='/'){comment='';i++;}continue;}
  if(quote){if(escaped)escaped=false;else if(c.charCodeAt(0)===92)escaped=true;else if(c===quote)quote='';continue;}
  if(c==='/'&&next==='/'){comment='line';i++;continue;}
  if(c==='/'&&next==='*'){comment='block';i++;continue;}
  if(c==='"'||c==="'"||c.charCodeAt(0)===96){quote=c;continue;}
  if(c==='{')depth++;
  if(c==='}'&&--depth===0)return source.slice(start,i+1);
 }
 throw Error('unterminated shipped function '+name);
}

const nativePath=process.env.DSH_WORKSPACE_CLIENT_PATH;
if(!nativePath){
 test('shipped DSH workspace visibility integration',{skip:'provide DSH_WORKSPACE_CLIENT_PATH'},()=>{});
}else{
 const source=await readFile(nativePath,'utf8');
 console.log('native-workspace-source-sha256='+createHash('sha256').update(source).digest('hex'));
 const scope={
  assertNever$1(value){throw Error('unexpected archived filter '+value);},
  mainSessionId(list){return list.current;},
  orderedUngrouped(members){return members;},
 };
 const declarations=['sessionVisible','buildGroup','groupByWorkspace'].map(name=>declaration(source,name)).join('\n');
 const native=vm.runInNewContext(declarations+'\n({sessionVisible,groupByWorkspace})',scope);
 const byId={
  legacy:{id:'legacy',origin:undefined,blank:false,title:'Existing root',createdAt:0},
  ordinary:{id:'ordinary',origin:undefined,blank:false,title:'Ordinary unrelated root',createdAt:0},
  controller:{id:'controller',origin:'subagent',blank:false,title:'Hidden project controller',createdAt:0},
  privateA:{id:'privateA',origin:'subagent',parentSessionId:'controller',blank:false,title:'Private A',createdAt:0},
  privateB:{id:'privateB',origin:'subagent',parentSessionId:'controller',blank:true,title:'Private B',createdAt:0},
 };
 for(const filter of ['default','show','only'])for(const attached of [false,true])for(const current of ['privateA','privateB']){
  test('native grouped/ungrouped hides children: '+filter+' attached='+attached+' current='+current,()=>{
   const archived=new Set(['privateA','privateB','controller']);
   const workspaces=[{workspaceId:'project',path:'/fixture',title:'Project',createdAt:'2026-01-01',sessionIds:attached?['legacy','controller','privateA','privateB']:['legacy']}];
   const groups=native.groupByWorkspace({ids:Object.keys(byId),byId,current},workspaces,archived,filter,undefined);
   const visible=Array.from(groups).flatMap(group=>Array.from(group.sessions).map(session=>session.id));
   assert.ok(!visible.includes('controller'));
   assert.ok(!visible.includes('privateA'));
   assert.ok(!visible.includes('privateB'));
   if(filter!=='only'){assert.ok(visible.includes('legacy'));assert.ok(visible.includes('ordinary'));}
  });
 }
 test('selected private blank remains hidden even with show-archived',()=>{
  assert.equal(native.sessionVisible(byId.privateB,'privateB',new Set(),'show'),false);
 });
 test('legacy original root is still visible/usable by user choice, not falsely private',()=>{
  assert.equal(native.sessionVisible(byId.legacy,'legacy',new Set(),'default'),true);
  assert.equal(byId.legacy.origin,undefined);
 });
 test('only private sessions never produce an Ungrouped conversation row',()=>{
  const ids=['controller','privateA','privateB'];
  const groups=native.groupByWorkspace({ids,byId,current:'privateA'},[],new Set(),'show',undefined);
  assert.equal(groups.length,0);
 });
}
