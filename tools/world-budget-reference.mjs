// The GPU page budget's rules as d62feb64 ran them, verbatim: one synchronous
// sort of every brick by distance per rule (world/worldViewRing.js
// worldBudgetDemand, wire/worldRender.js budgetDemand). Only the owner's
// closure variables became ctx's fields. tools/world-budget-slices-cpu-check.mjs
// holds the sliced rules (worldBudgetDemandSteps, worldFarthestSteps,
// worldBudgetPass) to these: the same drops, evictions and kept demand.
import { BRICK } from '../src/shaders/common.js';
import { READY } from '../src/world/renderAtlas.js';
import { WORLD_VIEW_NEAR_RADIUS } from '../src/world/worldViewRing.js';
import { worldRunSliced } from '../src/world/worldSlices.js';
import { worldOutsideSteps } from '../src/wire/worldRender.js';

export function worldBudgetDemand(ids, { budget, eye, brick, held = new Set(), air = null, radius = WORLD_VIEW_NEAR_RADIUS, fresh = null, room = Infinity, resident = null }) {
  const all = [...ids], isFresh = (i) => !fresh || fresh.has(i);
  let over = all.length - budget, short = all.filter(isFresh).length - room;
  if (!(over > 0 || short > 0) || !eye) return { keep: new Set(all), dropped: [], air };
  const far = [];
  for (const i of all) {
    if (held.has(i)) continue;
    const b = brick(i), d = Math.hypot(...b.map((n, k) => (n + 0.5) * BRICK - eye[k]));
    if (d > radius) far.push([d, i, b]);
  }
  far.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const drop = [];
  for (const e of far) {
    if (over <= 0 && short <= 0) break;
    const f = isFresh(e[1]);
    if (over <= 0 && !f) continue;   // only the pool is short: only a new page frees room
    drop.push(e); over--; if (f) short--;
  }
  const dropped = new Set(drop.map(([, i]) => i));
  let next = air;
  const lower = drop.filter(([, i]) => !resident?.has(i));
  if (lower.length && air) {
    const floors = Uint32Array.from(air.floors);
    for (const [, , b] of lower) { const c = b[0] + air.dims[0] * b[2]; floors[c] = Math.min(floors[c], b[1]); }
    next = Object.freeze({ floors, dims: air.dims });
  }
  return { keep: new Set(all.filter((i) => !dropped.has(i))), dropped: drop.map(([, i]) => i), air: next };
}

// worldRender.js budgetDemand(t, ids) at d62feb64. ctx: the closure's atlas,
// budget, cellCurrent, brick, owned sets, viewAirFor, reclaim, and
// setViewAir(air) for its `viewAir={air,id:++viewAirId}`.
export async function budgetDemand(t, ids, { atlas, budget, cellCurrent, brick, ownedSources, ownedProbes, ownedGlow, viewAirFor, setViewAir, reclaim, pause }) {
    const outside=await worldRunSliced(worldOutsideSteps(atlas.live.cell.keys(),ids,t.full),{pause});
    const limit=Math.max(0,budget.cell-outside),roomNow=()=>Math.max(0,budget.pool.cell-atlas.poolUsed('cell'));
    let room=roomNow();
    if(ids.size<=limit&&ids.size<=room)return;
    // classify()'s rule: a current page is not packed again
    const fresh=new Set(),resident=new Set();
    for(const i of ids)(cellCurrent(i)?resident:fresh).add(i);
    if(ids.size<=limit&&fresh.size<=room)return;
    const eye=t.frame.values?.cam,cam=eye&&Array.from(eye).length===3&&Array.from(eye).every(Number.isFinite)?Array.from(eye):null;
    const current=await viewAirFor();let air=current.air;
    const drop=(r,why)=>{
      // (2026-10-22: also from resident, the one fix past d62feb64: a dropped brick's page
      // was evicted twice by the last pass, freeing nothing; same fix in worldRender.js)
      for(const i of r.dropped){ids.delete(i);fresh.delete(i);resident.delete(i);t.requirements.delete(i);t.support.delete(i);t.dropped.add(i);}
      air=r.air;t.budgetDropped=t.dropped.size;
      console.warn(`WORLD load over its GPU page budget (${budget.cell} pages, pool ${budget.pool.cell}): ${r.dropped.length} farthest bricks dropped${why}`);
    };
    // only bricks this load asked for may go: never a held page, a glow core's region, a record's brick or a pinned support brick
    const held=new Set([...ids].filter(i=>!t.requirements.has(i)||t.pinned.has(i)||ownedSources.has(i)||ownedProbes.has(i)||ownedGlow.has(i)));
    const r=worldBudgetDemand(ids,{budget:limit,eye:cam,brick,held,air,fresh,room,resident});
    if(r.dropped.length)drop(r,'');
    if(fresh.size>room){await reclaim('cell',()=>fresh.size-roomNow());room=roomNow();}
    const keeps=i=>t.pinned.has(i)||t.squeezed.has(i)||ownedSources.has(i)||ownedProbes.has(i);
    const far=(list)=>{const at=cam??[0,0,0];return list.map(i=>[Math.hypot(...brick(i).map((n,k)=>(n+0.5)*4-at[k])),i]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]).map(([,i])=>i);};
    // Pages kept resident (a load never evicts one), farthest first: the ones
    // outside this demand, then (past them) this demand's own; an evicted one
    // of the demand is dropped from it, its misses settled as a dropped brick's
    // (worldSettleFeedback).
    const evict=async(list)=>{
      const out=far(list.filter(i=>!keeps(i))).slice(0,fresh.size-room);if(!out.length)return;
      atlas.remove(out.map(brick),READY.CELL);
      for(const i of out)if(ids.has(i)){ids.delete(i);resident.delete(i);t.requirements.delete(i);t.support.delete(i);t.dropped.add(i);t.squeezed.add(i);}
      t.budgetDropped=t.dropped.size;
      console.warn(`WORLD load over its GPU page budget (${budget.cell} pages, pool ${budget.pool.cell}): ${out.length} farthest resident pages evicted`);
      await reclaim('cell',()=>fresh.size-roomNow());room=roomNow();
    };
    if(fresh.size>room)await evict([...atlas.live.cell.keys()].filter(i=>!ids.has(i)));
    if(fresh.size>room){
      const r2=worldBudgetDemand(ids,{budget:Infinity,eye:cam??[0,0,0],brick,held:new Set([...ids].filter(keeps)),air,fresh,room,resident,radius:0});
      for(const i of r2.dropped)t.squeezed.add(i);
      if(r2.dropped.length)drop(r2,' (past the near ring rule: the pool is full)');
    }
    if(fresh.size>room)await evict([...resident]);
    if(air!==current.air)setViewAir(air);
}
