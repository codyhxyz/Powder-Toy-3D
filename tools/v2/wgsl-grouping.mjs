// CPU-only supplement to Naga: require explicit grouping around mixed bitwise
// expressions, which Chromium rejects even when Naga parses them.
import { WgslParser } from 'wgsl_reflect/wgsl_reflect.module.js';

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
