// Trusted internal engine registry, not an adversarial module sandbox.
// Only worldLightingHistory issues entries; callers cannot clone their brand.
const restores=new WeakMap();
export function _issueWorldLightingRestore(lease,state){restores.set(lease,state);}
export function validateWorldLightingRestore(lease,{job,kind=lease?.kind,index=lease?.index,publication=lease?.publication}={}) {
  const r=restores.get(lease);
  if(!r || !r.valid() || lease.kind!==kind || lease.index!==index || publication!==lease.publication) throw new Error('invalid/stale ledger restore lease');
  r.check();
  if(job){
    const tick=kind==='source'?'sourceTick':'giTick',d=job.dependencies?.[kind],t=lease.token;
    if(job.publication!==publication||job.kind!=='light'||job.epoch!==publication.epoch||job.sourceRevision!==publication.sourceRevision||job[tick]!==t.lightingTick||d?.id!==t.dependencySetID||d?.version!==t.dependencyVersion||(job.brick[0]+r.size[0]/4*(job.brick[1]+r.size[1]/4*job.brick[2]))!==index) throw new Error('ledger restore job provenance mismatch');
  }
  return lease;
}

