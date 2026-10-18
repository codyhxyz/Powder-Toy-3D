// CPU-only WGSL checks shared by tools/v2. Naga needs its CLI (cargo install
// naga-cli); none of this substitutes for WebGPU runtime checks.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';

// Write `text` to a fresh temporary file; `done()` removes it.
function tempFile(name,text) {
  const dir=mkdtempSync(join(tmpdir(),'v2-wgsl-')),file=join(dir,name);writeFileSync(file,text);
  return { file, done:()=>rmSync(dir,{recursive:true,force:true}) };
}

// Naga's diagnostics for one generated module, or '' when it validates.
// A missing Naga binary throws instead of passing.
export function nagaErrors(code) {
  const {file,done}=tempFile('module.wgsl',code);
  try {
    const result=spawnSync('naga',[file],{encoding:'utf8'});
    if(result.error) throw result.error;
    return result.status ? `${result.stdout}${result.stderr}` || `naga exited ${result.status}` : '';
  } finally { done(); }
}
export const assertNaga=(code,label='WGSL')=>{ const errors=nagaErrors(code); if(errors) throw new Error(`${label}: ${errors}`); };

// Import `entry` as Vite's minified production build, so checks compare the
// WGSL the shipped bundle emits with the source module's.
export async function importMinified(entry) {
  const { build }=await import('vite');
  const bundle=await build({configFile:false,logLevel:'warn',build:{write:false,minify:true,lib:{entry,formats:['es']}}});
  const chunk=(Array.isArray(bundle)?bundle[0]:bundle).output.find(c=>c.type==='chunk'&&c.isEntry);
  if(!chunk) throw new Error(`${entry}: production bundle has no entry chunk`);
  const {file,done}=tempFile('module.mjs',chunk.code);
  try { return await import(pathToFileURL(file)); } finally { done(); }
}

// Supplement to Naga: require explicit grouping around mixed bitwise
// expressions, which Chromium rejects even when Naga parses them.
const bitwise=new Set(['&','|','^','<<','>>']);
const binary=new Set([...bitwise,'+','-','*','/','%','==','!=','<','<=','>','>=','&&','||']);
export function wgslGroupingErrors(source) {
  const errors=[],seen=new Set();
  function visit(node,line=1) {
    if(!node || typeof node!=='object' || seen.has(node)) return;
    seen.add(node);
    line=node.line>0?node.line:line;
    if(binary.has(node.operator) && node.left && node.right) {
      for(const child of [node.left,node.right]) {
        if(binary.has(child.operator) && !child.hasParen && node.operator!==child.operator
          && (bitwise.has(node.operator) || bitwise.has(child.operator))) {
          errors.push(`line ${line}: group '${child.operator}' mixed with '${node.operator}'`);
        }
      }
    }
    for(const value of Object.values(node)) {
      if(Array.isArray(value)) value.forEach(child=>visit(child,line));
      else visit(value,line);
    }
  }
  visit(new WgslParser().parse(source));
  return errors;
}
