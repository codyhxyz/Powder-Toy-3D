import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { VIEWS, isTestView, isMaterialView, materialStyleForView, viewKey } from '../src/views.js';
import { hybridEligibility } from '../src/gfx/hybrid/index.js';
import { VOLUME_VIEWS, viewShadows, volumeFrag } from '../src/shaders/render.js';
import { gridLayout } from '../src/sim.js';
import { createShaderPicker } from '../src/ui/shaders.js';

const test = VIEWS.find(v => v.key === 'test');
assert.equal(test.name, 'Test');
assert.equal(test.experimental, true);
assert(isTestView(test.id) && isTestView('test') && !isTestView(0));
assert(isMaterialView(test.id) && VOLUME_VIEWS.includes('test') && viewShadows('test'));
assert.equal(materialStyleForView('test'), 0);
assert.equal(viewKey(0), 'realistic');
for (const key of ['id', 'key', 'hotkey']) assert.equal(new Set(VIEWS.map(v => v[key])).size, VIEWS.length);
assert.equal(hybridEligibility({ view: 'test' }), null);
for (const extra of [{ decoration: true }, { sourceAppearance: true }, { warp: { k: 1 } }, { disabled: true }]) {
  assert(hybridEligibility({ view: 'test', ...extra }));
}
for(const curved of [false,true])for(const sourceAppearance of [false,true]){
  const g={...gridLayout(32,32,32),sourceAppearance};
  const code=volumeFrag(g,{view:'test',curved});
  assert.equal(code.replace(/^\/\/ volume: test/,'// volume: realistic'),volumeFrag(g,{view:'realistic',curved}),
    'unsupported Test scenes must keep exactly the Realistic fallback shader');
  const result=spawnSync('naga',['--stdin-file-path','test-view.wgsl'],{input:code,encoding:'utf8'});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stdout+result.stderr);
}

// Exercise the real app function, replacing only its module transport.
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const ensure = app.match(/function ensureHybrid\(\) \{[\s\S]*?\n\}/)[0]
  .replace("import('./gfx/hybrid/index.js')", 'loadModule()');
const machine = Function('isTestView', 'loadModule', 'initial', `
  let settings={view:initial.view??0,scene:'island'},sim=initial.sim??{id:'A'};
  let hybrid=null,hybridLoad=null,hybridModule=initial.module??null;
  const hybridOptIn=!!initial.force,graphicsFailure=false,worldMode=null,gpu={};
  const events={created:[],disposed:[],resets:0,drops:0,toasts:[]};
  const post={reset(){events.resets++;}},meshFrames={drop(){events.drops++;}};
  const hud={toast(message){events.toasts.push(message);}},console={warn(){}};
  const sceneByKey=()=>({}),wakeLoop=()=>{},wakeWhen=()=>{};
  function setView(id){settings.view=id;ensureHybrid();}
  ${ensure}
  return {events,setView,ensureHybrid,get view(){return settings.view;},
    get renderer(){return hybrid;},get pending(){return hybridLoad;},
    replaceSim(next){hybrid?.dispose();hybrid=null;sim=next;ensureHybrid();}};
`);
const deferred = () => {
  let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; });
  return { promise, resolve, reject };
};
const moduleFor = events => ({ createHybridRenderer(gpu, sim) {
  events.created.push(sim.id);
  return { sim, ready: Promise.resolve(), dispose() { events.disposed.push(sim.id); } };
} });
{
  const transport=deferred(); let imports=0;
  const m=machine(isTestView,()=>{imports++;return transport.promise;},{});
  m.ensureHybrid(); assert.equal(imports,0,'normal startup must not load or allocate hybrid');
  m.setView(test.id); const pending=m.pending;
  m.setView(0); transport.resolve(moduleFor(m.events)); await pending;
  assert.equal(m.renderer,null,'leaving Test during import must not resurrect it');
  m.setView(test.id); assert.deepEqual(m.events.created,['A']); assert.equal(imports,1);
  m.setView(6); assert.equal(m.renderer,null); assert.deepEqual(m.events.disposed,['A']);
  assert(m.events.resets>0&&m.events.drops>0);
}
{
  const transport=deferred(),m=machine(isTestView,()=>transport.promise,{view:test.id});
  m.ensureHybrid(); const pending=m.pending;
  m.replaceSim({id:'B'}); transport.resolve(moduleFor(m.events)); await pending;
  assert.deepEqual(m.events.created,['B'],'an import landing after grid replacement must use the current simulation');
  m.replaceSim({id:'C'}); assert.deepEqual(m.events.disposed,['B']);
  assert.deepEqual(m.events.created,['B','C']);
}
{
  const transport=deferred(),m=machine(isTestView,()=>transport.promise,{view:test.id});
  m.ensureHybrid(); const pending=m.pending; transport.reject(new Error('offline')); await pending;
  assert.equal(m.view,0); assert.equal(m.renderer,null); assert.equal(m.events.toasts.length,1);
}
{
  // A force-query boot imports before build(); mimic that transport resolution.
  const transport=deferred(),q=machine(isTestView,()=>transport.promise,{force:true});
  q.ensureHybrid(); const pending=q.pending; transport.resolve(moduleFor(q.events)); await pending;
  q.setView(0); assert.equal(q.renderer.sim.id,'A','old renderer=hybrid opt-in remains supported');
}
assert.match(app,/await hybridLoad;\s*const h = hybrid;\s*if \(h\) await h\.ready;\s*if \(s !== sim \|\| v !== vol \|\| h !== hybrid\) continue/);
{
  const save=app.match(/function save\(\) \{[\s\S]*?\n\}/)[0];
  for(const view of [0,6,test.id]){
    let saved;
    Function('settings','isTestView','localStorage',`
      let saveTimer=0;const STORE='test',REV_KEY='revision',DEFAULT_CHANGES=[];
      const DEFAULTS={view:0},PERSIST=['view','radius'];
      const clearTimeout=()=>{},setTimeout=fn=>{fn();return 1;};
      ${save} save();
    `)({view,radius:9},isTestView,{setItem(key,value){saved=JSON.parse(value);}});
    assert.equal(saved.view,isTestView(view)?0:view);assert.equal(saved.radius,9);
  }
}

// CPU-only DOM: no browser, adapter, or physical GPU.
class Element {
  nodeType=1; children=[]; attrs={}; dataset={}; hidden=false; style={setProperty(){}};
  classes=new Set();
  classList={add:x=>this.classes.add(x),toggle:(x,on)=>on?this.classes.add(x):this.classes.delete(x)};
  constructor(tag){this.tagName=tag.toUpperCase();}
  append(...nodes){this.children.push(...nodes);}
  setAttribute(k,v){this.attrs[k]=String(v);}
  addEventListener(k,fn){(this.listeners??={})[k]=fn;}
  contains(n){return this===n||this.children.some(c=>c.contains?.(n));}
  focus(){document.activeElement=this;}
}
const oldDocument=globalThis.document,oldRaf=globalThis.requestAnimationFrame;
try{
  globalThis.document={createElement:tag=>new Element(tag),createTextNode:text=>({nodeType:3,textContent:String(text)}),
    body:new Element('body'),addEventListener(){},activeElement:null};
  globalThis.requestAnimationFrame=fn=>queueMicrotask(fn);
  const settings={view:0},rendered=[],trigger=new Element('button');
  const picker=createShaderPicker({settings,views:VIEWS,trigger,
    async renderThumb(id){rendered.push(id);return true;},onChange:id=>{settings.view=id;},onClose(){}});
  picker.setOpen(true);await new Promise(setImmediate);
  assert(!rendered.includes(test.id),'Test must not advertise a legacy thumbnail as its own');
  assert.equal(rendered.length,VIEWS.length-1);
  const all=node=>[node,...(node.children??[]).flatMap(all)];
  const card=all(picker.el).find(n=>n.attrs?.['aria-label']==='Test');
  assert(card&&all(card).some(n=>n.textContent===test.desc));
  assert(all(card).some(n=>n.textContent==='Experimental renderer'&&!n.hidden));
  card.listeners.click();assert.equal(settings.view,test.id);assert.equal(card.attrs['aria-pressed'],'true');
  picker.setOpen(false);assert.equal(document.activeElement,trigger);
}finally{
  if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  if(oldRaf===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=oldRaf;
}
console.log('PASS Test view: opt-in metadata, Naga fallback equivalence, lazy creation/current-grid ownership, teardown, query compatibility, import recovery, session-only persistence and accessible picker disclosure (CPU only)');
