// Actual production factories, registered independently of application switching.
import { volumeFrag,pickFrag,VOLUME_LAYOUTS,PICK_LAYOUTS,VOLUME_VIEWS,REALISTIC_LEVELS,volumePipeline } from './render.js';
import { isMaterialView } from '../views.js';
import { WORLD_NATIVE } from './gfx/liquidDetail.js';
export const WORLD_SHADER_GRIDS = [128,384].flatMap(ny=>[false,true].map(sourceAppearance=>({nx:3072,ny,nz:1024,sourceAppearance,sourceGrid:[128,0,128]})));
export const WGSL_CHECK = () => WORLD_SHADER_GRIDS.flatMap(g=>{
  const tag=`${g.ny}.${g.sourceAppearance?'source':'native'}`;
  return [
    ...VOLUME_VIEWS.flatMap(view=>(isMaterialView(view)?Object.entries(REALISTIC_LEVELS):[['data',()=>({})]]).flatMap(([level,d])=>[false,true].map(curved=>({
      name:`world.volume.${tag}.${view}.${level}${curved?'.curved':''}`,kind:'render',grids:false,warm:false,
      code:()=>volumeFrag(g,{backend:'world',view,detail:d(),curved}),layouts:()=>VOLUME_LAYOUTS({backend:'world'}),...volumePipeline(),
    })))),
    // Physics V2's World programs (WORLD_NATIVE: V2's foam on liquids and lava, as the Box draws it):
    // the most foam text added (detail off), the largest module (full) and its curved twin.
    ...[['off',false],['full',false],['full',true]].map(([level,curved])=>({
      name:`world.volume.${tag}.realistic.${level}.v2${curved?'.curved':''}`,kind:'render',grids:false,warm:false,
      code:()=>volumeFrag(g,{backend:'world',view:'realistic',detail:{...REALISTIC_LEVELS[level](),[WORLD_NATIVE]:true},curved}),layouts:()=>VOLUME_LAYOUTS({backend:'world'}),...volumePipeline(),
    })),
    {name:`world.pick.${tag}`,kind:'compute',grids:false,warm:false,code:()=>pickFrag(g,{backend:'world'}),layouts:()=>PICK_LAYOUTS({backend:'world'}),dispatch:()=>[1,1,1]},
  ];
});
