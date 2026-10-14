# Cruelty Squad mission enemies: evidence and adaptation

Only `createMission` supplies `combatProfile` to `createNpc`. Sandbox, Halo,
Siege and other NPC callers retain their original wizard figures and minds.
Mission actors use the existing Agent's Attack/Hunt/Wander/Extinguish goals,
A* navigation, physics bodies, hit targets and weapon rigs. No global AI rewrite.
The isolated mind has no Hiisi flight, digging, material collection or building.

## Source evidence (not a claim of exact parity)

Inspected locally:

- `/private/tmp/cruelty-vr-unpacked/Obj_Nerd_{1,2,3}.tscn`: root
  `EnemyHandler.gd`, `health = 15`, `civilian = true`, `stupid = true`,
  objective flag, animated models, ordinary body/collision helpers.
- `/private/tmp/cruelty-vr-unpacked/Player_Test.tscn`: VR player/rotation helper
  and weapon scaffolding; it **does not contain enemy default stats**.
  Supplied `Entities/` contains VR player scenes/scripts only, not enemy scenes.
- Decompiled/fixed modding script reference:
  https://github.com/CruS-Modding-Infrastructure/crus-project-setup-tool
  commit `199c95dff59cc663e958762bdab23149fa3794f7`, under
  `_SETUP_PROJECT_/project_scripts/Scripts/`:
  - `EnemyHandler.gd:3-20`: default health 100, armor, civilian/stupid/objective
    flags. A default is not proof of each enemy scene's override.
  - `E_Grunt_Movement_New.gd:15-59,386-429,443-492`: AI distance 100m,
    movement 4.5m/s, engage distance 7m, front-hemisphere ray LOS,
    initial spotting 0.5s, reaction threshold 9 with accumulation 15/s
    (approximately another 0.6s), last-known pathing/alert, burst counters.
  - `weapon.gd:3,26-28,93-94,539-540,2171-2180`: enemy accuracy 0.1 rad
    by default, random x/y aim angles, pistol damage 20, weapon enum and
    timer/ammo-gated AI firing. Original pistol timer is 0.2s and SMG 0.07s
    (`1084`, `1123`); destination tools/ammunition are not identical.
  - `Stupid_Civilian.gd` / `E_Civilian_Movement.gd`: civilians have separate
    non-combat behavior. This implementation's flee-on-hurt is an adaptation,
    not a transcription of their dialogue/navigation system.

These scripts are a decompiled modding reference, not verified vanilla scene
exports. No original enemy meshes, textures or scripts are copied into the game.

Additional scene evidence: `V0IDDR0ID/BrutalSquad`, commit
`2c0bd3b510687ebfe0df2c81c012e116cd932258`,
`BrutalSquad/Entities/Enemies/`. These are mod scenes, not proof of every vanilla
default. `Obj_Chief.tscn` specifies 300 HP, 1 m/s movement, 2 m engagement and an
acid-spray weapon. `E_Cop_Narc.tscn` specifies 50 HP, 7 m/s movement, 5 m
engagement, a shotgun and poison-on-death. `Obj_Cult_Leader.tscn` explicitly sets
15 HP, civilian and stupid; it must not become hostile merely because its name
sounds threatening. These classifications replace the earlier unknown-target
fallbacks. Supplied Nerd scenes likewise default to stationary civilians.

## Profile policy

`sourceResource` is classified before legacy `sourcePath`/name. Authored primitive
`sourceProperties` overrides include `health`, `civilian`, `stupid`,
`reaction_time`, `ai_distance`, `move_speed`, `engage_distance`, `no_patrol`,
`burst`, `enemy_accuracy` and `current_weapon`; `sourceYaw` seeds facing.
Inline `EnemyHandler.gd` roots default hostile unless explicitly civilian.
Objective membership alone does not imply passive. `passive` remains an explicit
adapter override. Unknown legacy targets remain passive, unknown guards use Grunt.
With source metadata, profile weapons supersede old importer-fabricated `['GUN']`;
legacy manually authored `weapons` lists are honored. Parent owns importer metadata.

The following **fallback archetype values are approximations**, not extracted
scene defaults. Role ordering makes elites/assassins more dangerous, ordinary
corporate guards fragile, shotgun stand-ins short-range, and civilians unarmed.
Actual supplied scene properties win where available.

| Archetype | Effective HP | Reaction s | Tool | Salvo start interval s / held s | Additional aim error rad |
|---|---:|---:|---|---|---:|
| Grunt | 40 | 1.1 | GUN | 0.65 / 0 | 0.10 |
| Elite | 100 | 0.8 | SMG | 1.5 / 0.6 | 0.045 |
| Security | 40 | 1.1 | SMG | 1.7 / 0.4 | 0.08 |
| Revolver cop | 50 | 1.1 | GUN | 0.9 / 0 | 0.06 |
| Shotgun cop | 50 | 1.2 | SMG stand-in | 1.8 / 0.16 | 0.12 |
| Assassin | 60 | 0.8 | SNIPER | 1.8 / 0 | 0.025 |
| Knifelord | 60 | 0.7 | AXE stand-in | existing melee windup | — |
| Mutant | 80 | 0.9 | AXE stand-in | existing melee windup | — |
| Chief | 300 | 1.1 | slow GUN stand-in for acid spray | 1.0 / 0 | 0.10 |
| Cop Narc | 50 | 1.1 | short SMG stand-in for shotgun | 1.8 / 0.16 | 0.12 |
| Cult Leader | 15 | — | none | — | — |
| Civilian / executive | 15 | — | none | — | — |
| Unclassified hostile objective | 100 | 1.1 | GUN | 0.7 / 0 | 0.08 |

No NPC shotgun or knife tool is present in the catalog; stand-ins retain actual
existing held models and ballistics, not fictional original weapon parity.
Chief's acid spray and Narc's poison-on-death are not reproduced.
Cadence is intentionally bounded for destination damage/tool behavior, not the
source's timer/ammo economy. Original per-scene equipment is absent unless supplied
as explicit `current_weapon` metadata. Aim error is held per salvo and added to the
existing gun cone; this avoids per-frame jitter but differs from source shot noise.

Source health is converted to effective **weapon-hit** capacity:
`damageScale = 40 / sourceHealth`, because destination pistol damage `.5` maps to
source pistol `20`. Nerds take one pistol hit, Grunts two, Elites five. Body health
remains normalized; SMG/melee damage, armor, headshots, exact-damage rules,
environmental damage, original negative-health grace and source weapon damage
are not reproduced. Environmental death and objective elimination still work.

Default vision is 100m (40m shotgun stand-in), front hemisphere before alert,
then LOS in any direction. No through-wall touch/radar acquisition. A hit alerts
the guard to the attacker; losing sight clears aim and hunts **last-known**, not
live unseen position, followed by search using the existing Wander goal.
Memory expires after 12s (an adaptation; original timeout uses frame counters).
The reference also paths toward the live player position after losing sight;
our last-known search deliberately avoids tracking an unseen live position.
Reacquisition waits again. No automatic squad-alert broadcast or source patrol
routes are invented. Ordinary civilians wait, flee after being hurt, never attack;
`stupid` civilians such as the Nerds remain stationary. Flee steering uses existing
movement/collision reflexes, not a new civilian path planner.

## Appearance

`figureCruelty.js` is procedural, ugly saturated low-poly corporate dystopia:
magenta/acid uniforms, armor pouches, police caps, employee badges, executive ties,
toxic civilian stripes, purple/green skin, asymmetric bulging eyes, tiny pupils,
exposed uneven teeth, respirator masks and mutant growths. Outfit and deterministic
face variation distinguish roles without external assets. Unlike the wizard,
the neutral silhouette fits the actual 1.6×5.5×1.6-cell hitbox. Existing animation,
right-hand articulation and weapon attachments remain; animated limbs/weapons can
extend beyond the ordinary body box exactly as other figure rigs do.
Static parts sharing a joint and color are batched to limit draw calls.

## CPU validation and remaining validation

`node tools/cruelty-enemies-cpu-check.mjs` goes through **real mission start and
real createNpc**, real bodies/geometry/AI selection; only the GPU/tool kit is stubbed.
It checks role variation, hostile objectives versus civilians, damage capacity,
LOS/front/range/alert, reaction/cadence/salvos, last-known search/expiry,
no-flight, authored overrides, neutral mesh bounds and non-mission isolation.
`tools/enemy-aim-cpu-check.mjs` separately exercises existing real firearm behavior.
`tools/mission-node-check.mjs` covers mission lifecycle/extraction/one-shot actors.

CPU checks do not prove exact original difficulty: dormant streamed-out actors,
weapon stand-ins, normalized damage and missing boss mechanics remain adaptations.
