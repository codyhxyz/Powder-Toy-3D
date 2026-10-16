# Draft liquid head and pressure contract

This is a CPU-only proposal, not an approved native fluid model.
Production physics, packed state, save formats and complete-velocity capability remain unchanged.
The current hole and SPLASH gates remain open.

## Define density and geometry first

Use the existing material mass calibration and cell width `ell`.
Let `rho0 = fullCellMass / ell³`.
Choose a linear liquid equation of state:

```
p = rho0 * c² * (rho/rho0 - 1)
specific enthalpy = c² * log(rho/rho0)
```

The wet region has `rho >= rho0`; its free surface has zero gauge pressure.
This is a constitutive choice, not a reinterpretation that preserves the old `headOf`.
For this draft, `c² = G_MS2 * CELL_M / nominal_COMP`.
Read `nominal_COMP` from the existing emitted shader.
Freeze this reference stiffness when testing a different timestep.
Do not tune it against hole reach or recompute it from each solver timestep.

Consider one cell under constant vertical gravity, with its bottom at `z=0`.
Normalize height by `ell`, mass by `rho0*ell³`, and pressure by `rho0*c²`.
Define `k=g*ell/c²`, fill `f=mass/fullCellMass`, occupied depth `alpha`, and bottom enthalpy `a*c²`.
Hydrostatic balance gives:

```
rho(z)/rho0 = exp(a - k*z),  0 <= z <= alpha
```

Integrate density, rather than assuming that fill equals occupied volume.
With `fc=expm1(k)/k`:

| State | Occupied depth `alpha` | Bottom enthalpy `a` |
| --- | --- | --- |
| `f <= fc` | `log1p(k*f)/k` | `log1p(k*f)` |
| `f > fc` | `1` | `k + log(f/fc)` |

At zero gravity, use `fc=1`, `alpha=min(f,1)` and `a=log(max(f,1))`.
Different partial fills then share zero enthalpy.
Head alone cannot recover their volume; fill remains authoritative.
This zero-gravity limit does not supply an interface orientation or a transport face area.

At nonzero gravity, `fc>1`.
Thus `f=1` is slightly below full occupied volume in this draft.
Any implementation must reconcile that change with rendering and tool volume semantics.
It must not silently retain the old fill-to-volume interpretation.

## Pressure traction and stored mechanical energy

The bottom and top pressures are:

```
pBottom/(rho0*c²) = expm1(a)
pTop/(rho0*c²) = max(0, expm1(a-k))
```

Their difference is `k*f`.
Multiplying by `rho0*c²*ell²` gives exactly the cell's material weight.
Adjacent cells at one hydrostatic surface have equal interface pressures.
No reservoir-height scan is required.

Integrating pressure over a vertical side face gives `Pi=f-alpha`.
The dimensionless elastic plus within-cell gravitational energy is:

```
Phi = f*a - f + alpha
dPhi/df = a
Pi = f*a - Phi
```

These expressions come from integrating the EOS energy and gravity over the wet region.
They are not an energy correction applied after a momentum update.
Add the cell-bottom gravitational potential when comparing different cell elevations.
Mechanical energy remains separate from the existing thermal bank.

For the covered branch, `dPi/df=1`.
Its acoustic scale is `c`, independent of compressed fill.
The earlier Courant-2 observation used a different, explicitly conditional EOS.
Neither result proves stability of a time integrator.

## One coupled horizontal-face identity

Let momentum be `j=f*u` in units of `fullCellMass*c`.
For a common cell-bottom elevation, use total energy `Phi+|j|²/(2f)`.
Its entropy variables and flux potential are:

```
w = (a-|u|²/2, u)
psi = Pi*uNormal
```

Braces below mean arithmetic averages; brackets mean right minus left.
A candidate entropy-conservative face flux is:

```
meanDensity = [Pi]/[a]
massFlux = meanDensity * {uNormal}
momentumFlux = massFlux*{u} + {Pi}*normal
```

For identical enthalpies, the tested degenerate branch uses average fill.
The flux satisfies `[w] dot flux = [psi]`.
An added scalar state-jump diffusion term has a nonpositive semidiscrete entropy contribution.
This identity includes tangential momentum, pressure and advection.
It is not a finite-time accepted transport algorithm.
It does not define vertical fluxes, oblique free surfaces or radial-gravity reconstruction.
The face checks use one material, not mixed liquid IDs or phase changes.

## CPU evidence and deliberate rejection examples

Run `node tools/v2/hydrostatic-contract-check.mjs`.
The script checks density, pressure and energy against independent numerical volume integrals.
It also checks shared hydrostatic interface pressure and the coupled horizontal-face identity.
No `World` instance or evolving fluid benchmark runs.

Two counterexamples remain explicit:

- Flooring accepted mass independently can violate the face entropy inequality.
- Forward Euler can increase energy despite an exact semidiscrete entropy identity.

Native use still requires a finite-time update with complete admission and error rules.
It must preserve material custody, thermal/payload admission and representability refusals.
Do not replace that work with a post-update kinetic-energy cap or outlet launch boost.
Do not authorize a momentum allocation or claim original outcome acceptance from these checks.

## First finite-step CPU gate

Run `node tools/v2/quantized-momentum-check.mjs`.
It tests one step on a three-cell, fully wet, one-material horizontal periodic ring.
The shared CPU reference is `tools/v2/hydrostatic-reference.mjs`; the application does not import it.
This is not a `World` variant or an evolving outcome benchmark.

The candidate uses the face flux above plus scalar conserved-state diffusion.
Its speed bound is `lambda=1+max(abs(uNormal))`, in units of the reference sound speed.
The reference timestep satisfies `lambda*tau <= 1/4`.
This ceiling is an explicit candidate constraint, not a demonstrated general stability theorem.
The unquantized finite proposal must also pass its measured energy check before rounding.

The representation is integer fill and signed i32 Q24 momentum.
Momentum units are `fullCellMass*c/2²⁴`.
That one-material reference scale is not approved for native storage, cross-material transfer or persistence.
Every input must explicitly declare known momentum.
Zero values do not supply that declaration.

Each canonical face rounds mass once.
Its momentum transfer includes the mass-rounding correction times the mean advecting velocity.
Then it rounds all three momentum components once.
Both neighbors consume the same signed integer transfers.
Thus integer mass and all momentum components conserve exactly.
Pressure and numerical stress are not replaced with a post-update velocity adjustment.

Before rounding, calculate a Taylor energy-error bound around the unquantized finite proposal.
For one cell, let `ef=1/FULL` and:

```
ep[a] = (abs(uMeanLeft[a])+abs(uMeanRight[a]))/(2*FULL) + 1/2²⁴
fmin = fReference - ef
umax = (norm(jReference)+norm(ep))/fmin
L = max(k, 1/fmin)
B = abs(wMass)*ef + sum(abs(u[a])*ep[a])
    + (L*ef² + (norm(ep)+umax*ef)²/fmin)/2
```

This uses the Hessian identity `d²E=a'*(df)²+norm(dj-u*df)²/f`.
A separate f64 arithmetic allowance is explicit.
The bound does not use the observed rounded energy error.
Tests check all sixteen corners of each reference cell's error box.
This is sampled numerical evidence, not certified interval arithmetic.

Publication occurs only after fill bounds, momentum representation and energy admission pass.
Any refusal returns the original state without partial stores.
Seven independent cases pass, including nonzero transport, tangential momentum and exact uniform rest.
Five refusals check near-capacity inflow, unknown momentum, dry input, momentum overflow and a near-dry rounding bound.
The latter conservatively refuses even uniform one-quantum liquid; wet/dry handling is unresolved.

The largest calculated rounding budget is about `1.97909e-5` in units of `fullCellMass*c²`.
Moving samples lose more energy than that budget.
This does not bound accumulated error over repeated steps.
No thermal bank or payload admission is modeled.

Timestep cost is not hidden.
The tested reference needs up to three microsteps per existing native liquid substep for one axis.
That is not a GPU timing result, an approved three-dimensional stepping schedule, or evidence of a faster completed engine.
Next gates include long-run error, actual material admission, wet/dry motion, vertical/gravity work and other gravity modes.

## References and scope

Existing game choices remain the TPT material calibration, Noita-style grid/flight custody, and the documented TF2 gravity scale.
The proposed closure introduces no fitted outcome coefficient.

Method references:

- [Li and Xing, hydrostatic reconstruction for Euler equations with gravitation](https://www.asc.ohio-state.edu/xing.205/research/lxJCP2018.pdf): EOS, pressure force and gravity must agree.
- [Tadmor, Entropy Stable Schemes](https://www.math.umd.edu/~tadmor/pub/TV%2Bentropy/Tadmor%20entropy%20stable%20schemes-c%20handbook2016.pdf): a spatial entropy identity does not replace time-discrete analysis.

These references motivate the checks; they do not validate this proposed free-surface closure.
