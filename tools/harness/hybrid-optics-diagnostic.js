// Test-only shader instrumentation. Never used by the application.
export function rewriteOpticsDiagnostic(code, variant, stepLimit = null, traceExit = false) {
  if (!code.includes('fn opticsTrace(')) return code;
  if(variant==='unlit-surfaces')return rewriteOpticsDiagnostic(rewriteOpticsDiagnostic(code,'hit'),'reflection');
  if(variant==='runtime-gi'){
    const loop='for (var k = 0; k < 8; k++)';
    if(code.split(loop).length!==2)throw new Error('Expected one eight-corner GI loop');
    // Diagnostic fixture only: its color texture is exactly 800 pixels wide.
    return code.replace(loop,'for (var k = 0; k < i32(textureDimensions(opticsColor).x / 100u); k++)');
  }
  const name = variant === 'steps' ? 'opticsTrace' : variant === 'hit' ? 'opticsWorldHit' : 'opticsEnvironment';
  const start = code.indexOf(`fn ${name}(`), begin = code.indexOf('{', start);
  if (start < 0 || begin < 0) throw new Error(`Missing diagnostic hook ${name}`);
  let end = begin, depth = 1;
  while (depth && ++end < code.length) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  if (depth) throw new Error(`Unbalanced diagnostic hook ${name}`);
  let body = code.slice(begin + 1, end);
  if (variant === 'steps') {
    if(traceExit){
      let exits=0;
      body=body.replace(/\bbreak;/g,()=>`diagnosticExit=${++exits}u;break;`);
      if(exits!==7)throw new Error('Optics diagnostic exit mapping changed');
      body=body.replace('if (!covered && traveled >= interval.y) { return out; }',
        'if (!covered && traveled >= interval.y) { diagnosticExit=8u;return out; }');
    }
    if(stepLimit!==null){
      const outer=/for \(var step = 0; step < \d+ \+ 64 \* \(NX \+ NY \+ NZ\)/;
      const grouped=/let (defaultTraversalLimit|traversalLimit) = \d+ \+ 64 \* \(NX \+ NY \+ NZ\);/;
      if(!Number.isInteger(stepLimit)||stepLimit<0||(!outer.test(body)&&!grouped.test(body)))throw new Error('Invalid diagnostic step limit');
      body=grouped.test(body)?body.replace(grouped,(_match,name)=>`let ${name} = ${stepLimit};`)
        :body.replace(outer,`for (var step = 0; step < ${stepLimit}`);
    }
    const declaration = 'var out: OpticsOutput;', loop = '    let probe = opticsProbe(p, rd);';
    const advance = '    p += rd * segment; traveled += segment;';
    if (![declaration, loop, advance].every(s => body.includes(s))) throw new Error('Optics diagnostic source changed');
    body = body.replace(declaration, `${declaration}
  var diagnosticSteps=0u;var diagnosticStalls=0u;var diagnosticInvalid=0u;${traceExit?'var diagnosticExit=0u;':''}`)
      .replace(loop, `    diagnosticSteps++;
    if(!all(abs(p)<=vec3f(1e8))||!all(abs(rd)<=vec3f(2.0))){diagnosticInvalid++;}
${loop}`)
      .replace(advance, `    let diagnosticPrior=p;
${advance}
    if(all(bitcast<vec3u>(p)==bitcast<vec3u>(diagnosticPrior))){diagnosticStalls++;}`)
      .replaceAll('return out;', `${traceExit?'out.metadata.x=f32(diagnosticExit);':''}out.metadata.y=f32(diagnosticStalls);out.metadata.z=f32(diagnosticInvalid);out.metadata.w=f32(diagnosticSteps);return out;`);
  } else body = variant === 'hit' ? 'return ALBEDO(h.id);' : 'return skyColor(d);';
  return code.slice(0, begin + 1) + body + code.slice(end);
}
