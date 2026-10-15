import { doorCellPositions } from './doorRuntime.js';
import { ELEMENTS } from '../../elements.js';

export function decodeImportedIndex(map, index) {
  return [index % map.size[0], Math.floor(index / map.size[0]) % map.size[1], Math.floor(index / (map.size[0] * map.size[1]))];
}
export function createImportedInteractionState(map, words, changed = () => {}, poseChanged = () => {}, resetAppearance = () => {}) {
  const originals = new Map(), states = new Map(), replacements = new Map();
  let epoch = 0;
  const indexOf = p => p[0] + map.size[0] * (p[1] + map.size[1] * p[2]);
  function address(index) {
    const [x,y,z] = decodeImportedIndex(map,index), d = map.brickDims;
    const brick = words[Math.floor(x/8)+d[0]*(Math.floor(y/8)+d[1]*Math.floor(z/8))];
    if (!brick || ![x,y,z].every((v,k) => v >= 0 && v < map.size[k])) throw new Error('Door ownership references an empty brick');
    const local = x%8+8*(y%8+8*(z%8));
    return [brick+(local>>2), (local&3)*8];
  }
  const read = index => { const [at,shift] = address(index); return (words[at]>>>shift)&255; };
  const originalId = index => { const [at,shift] = address(index); return ((originals.get(at)??words[at])>>>shift)&255; };
  function write(cells, ids) {
    const touched = new Set();
    for (let i = 0; i < cells.length; i += 2) {
      const [at,shift] = address(cells[i]);
      if (!originals.has(at)) originals.set(at,words[at]);
      words[at] = ((words[at]&~(255<<shift)) | (ids[i/2]<<shift))>>>0;
      touched.add(at);
    }
    const sorted = [...touched].sort((a,b) => a-b);
    for (let i=0;i<sorted.length;) {
      const from=sorted[i++]; let end=from+1;
      while(sorted[i]===end) { end++; i++; }
      changed(from,words.subarray(from,end));
    }
  }
  const initial = door => ({ open:false, targetOpen:false, progress:0, desiredProgress:0,
    alive:new Uint8Array(door.cells.length/2).fill(1), placed:new Uint8Array(door.cells.length/2).fill(1), elapsed:0 });
  const api = {
    get epoch() { return epoch; }, states,
    ensure(door) { if (!states.has(door.sourcePath)) states.set(door.sourcePath,initial(door)); return states.get(door.sourcePath); },
    target(door, open) {
      const s=api.ensure(door); s.open=s.targetOpen=open; s.desiredProgress=open?1:0; s.elapsed=0;
    },
    move(door, progress, alive, placed, observedOld) {
      const s=api.ensure(door), old=doorCellPositions(map,door,s.progress), next=doorCellPositions(map,door,progress);
      const edits=new Map();
      for(let i=0;i<old.length;i++) if(s.placed[i] && s.alive[i]) {
        const index=indexOf(old[i]), expected=door.cells[i*2+1];
        // Preserve live foreign replacements, rather than teaching the canonical
        // generator that a replaced cell was empty or still belongs to the leaf.
        const id=observedOld[i]===expected?0:observedOld[i];
        if(read(index)===expected) edits.set(index,id);
        if(originalId(index)!==id) replacements.set(index,id);
        else replacements.delete(index);
      }
      for(let i=0;i<next.length;i++) if(alive[i] && placed[i]) {
        const index=indexOf(next[i]); edits.set(index,door.cells[i*2+1]); replacements.delete(index);
      }
      write([...edits].flatMap(([index,id])=>[index,id]),[...edits.values()]);
      Object.assign(s,{progress,alive:Uint8Array.from(alive),placed:Uint8Array.from(placed)});
      poseChanged(door,progress);
    },
    snapshot() {
      return {version:2,replacements:[...replacements].sort((a,b)=>a[0]-b[0]).flat(),doors:[...states].map(([sourcePath,s])=>({sourcePath,open:s.open,targetOpen:s.targetOpen,
        progress:s.progress,desiredProgress:s.desiredProgress,alive:[...s.alive],placed:[...s.placed],elapsed:s.elapsed}))};
    },
    restore(saved) {
      const doors=map.interactions?.doors??[],seen=new Set(),validated=[];
      const restoredReplacements=new Map();
      if(saved!=null) {
        if(![1,2].includes(saved.version)||!Array.isArray(saved.doors)||saved.doors.length>doors.length) throw new Error('Invalid saved door state');
        for(const s of saved.doors) {
          const door=doors.find(d=>d.sourcePath===s.sourcePath), n=door?.cells.length/2;
          const mask=v=>Array.isArray(v)&&v.length===n&&v.every(x=>x===0||x===1);
          const fraction=v=>Number.isFinite(v)&&v>=0&&v<=1;
          if(!door?.supported||seen.has(s.sourcePath)||typeof s.open!=='boolean'||!mask(s.alive)||!Number.isFinite(s.elapsed)||s.elapsed<0) throw new Error('Invalid saved door state');
          const v=saved.version===1 ? {...s,targetOpen:s.open,progress:door.motion&&s.open?1:0,desiredProgress:s.open?1:0,placed:s.alive.map(v=>door.motion?v:s.open?0:v)} : s;
          if(typeof v.targetOpen!=='boolean'||v.open!==v.targetOpen||!fraction(v.progress)||!fraction(v.desiredProgress)||v.desiredProgress!==(v.targetOpen?1:0)||!mask(v.placed)||v.placed.some((x,i)=>x&&!v.alive[i])) throw new Error('Invalid saved door state');
          // Preflight all target addresses BEFORE resetting or mutating words.
          for(const index of door.cells.filter((_,i)=>i%2===0)) address(index);
          if(door.motion) for(const p of doorCellPositions(map,door,v.progress)) address(indexOf(p));
          validated.push([door,v]); seen.add(s.sourcePath);
        }
        const entries=saved.version===2?(saved.replacements??[]):[];
        if(!Array.isArray(entries)||entries.length%2||entries.length>map.size.reduce((a,b)=>a*b,1)*2) throw new Error('Invalid saved door replacements');
        for(let i=0;i<entries.length;i+=2) {
          const index=entries[i],id=entries[i+1],p=decodeImportedIndex(map,index);
          if(!Number.isSafeInteger(index)||index<0||index>=map.size.reduce((a,b)=>a*b,1)||restoredReplacements.has(index)||!Number.isInteger(id)||!ELEMENTS[id]||
              !validated.some(([door])=>door.motion&&p.every((v,k)=>v>=door.motion.sweptBounds.min[k]&&v<door.motion.sweptBounds.max[k]))) throw new Error('Invalid saved door replacements');
          address(index); restoredReplacements.set(index,id);
        }
        const placedIDs=new Map();
        for(const [door,s] of validated) if(door.motion) doorCellPositions(map,door,s.progress).forEach((p,i)=> {
          if(!s.placed[i]) return;
          const index=indexOf(p),id=door.cells[i*2+1];
          if(restoredReplacements.has(index)||(placedIDs.has(index)&&placedIDs.get(index)!==id)) throw new Error('Invalid saved door placement');
          placedIDs.set(index,id);
        });
      }
      api.reset();
      // Clear original ownership first for every leaf (overlaps remain static).
      for(const [door,s] of validated) {
        write(door.cells,door.cells.filter((_,i)=>i%2===1).map(()=>0));
        states.set(door.sourcePath,{...s,alive:Uint8Array.from(s.alive),placed:Uint8Array.from(s.placed)});
      }
      write([...restoredReplacements].flat(),[...restoredReplacements.values()]);
      for(const [index,id] of restoredReplacements) replacements.set(index,id);
      for(const [door,s] of validated) {
        if(door.motion) {
          const edits=new Map();
          doorCellPositions(map,door,s.progress).forEach((p,i)=> {
            const index=indexOf(p), id=door.cells[i*2+1];
            // Saved placement is proof the live edit found empty/owned terrain.
            // The source generator may still contain a static cell dug away
            // before that placement; do not silently discard a valid midpose.
            if(s.placed[i]) edits.set(index,id);
          });
          write([...edits].flatMap(([index,id])=>[index,id]),[...edits.values()]);
          poseChanged(door,s.progress);
        } else write(door.cells,s.alive.map((v,i)=>!s.open&&v?door.cells[i*2+1]:0));
      }
    },
    open(door,alive) {
      if(!door.supported) return false;
      const s=initial(door); Object.assign(s,{open:true,targetOpen:true,desiredProgress:1,alive:Uint8Array.from(alive),placed:new Uint8Array(alive.length)});
      states.set(door.sourcePath,s); write(door.cells,alive.map(()=>0)); return true;
    },
    close(door,restored) {
      const s=states.get(door.sourcePath); if(!s?.open) return false;
      const alive=Uint8Array.from(restored,(v,i)=>v&&s.alive[i]?1:0);
      write(door.cells,Array.from(alive,(v,i)=>v?door.cells[i*2+1]:0));
      Object.assign(s,{open:false,targetOpen:false,desiredProgress:0,alive,placed:alive.slice(),elapsed:0}); return true;
    },
    reset() {
      epoch++;
      for(const [at,word] of originals) { words[at]=word; changed(at,words.subarray(at,at+1)); }
      originals.clear(); states.clear(); replacements.clear(); resetAppearance();
    },
  };
  return api;
}
