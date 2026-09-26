# Tiny Planet Courier

**Play: <https://tiny-planet-courier.vercel.app>**

A single-page, browser-based 3D delivery game. You play a courier on a miniature
spherical planet, carrying parcels from the depot to mailboxes and villagers
scattered across five biomes. Other players appear in real time and can throw
floating emoji at you.

No install, no sign-in, no downloaded art. Desktop and mobile.

Frontend on Vercel (auto-deploys from `main`), realtime and Postgres on Supabase.
There is no game server to run.

---

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. The game works with no configuration at
all — without a `.env` it simply runs single-player.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck, then production bundle into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run server` | The optional self-hosted Socket.io relay on :8787 |
| `npm run dev:all` | Dev server + relay together |

Requires Node 20+ (the relay uses Node's native TypeScript stripping, which
needs 22.6+; everything else is bundled by Vite).

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows | Walk |
| `Shift` | Run |
| `Space` | Jump |
| `E` / `Enter` | Collect a parcel, hand one over, or talk to a villager |
| `1`–`6` | Emoji reaction |
| Mouse | Look (click to lock the pointer; dragging also works) |
| Wheel | Zoom |
| `Tab` | Customise courier |
| `Esc` | Pause |
| `G` | Toggle graphics quality |
| `H` | How to play |
| `M` | Mute |

On touch devices the left thumb drives a virtual stick, the right half of the
screen is a drag-to-look pad, and Run / Jump / `E` / reactions sit under the
right thumb.

---

## How it works

### Walking on a sphere

The whole design follows from one decision: **terrain height is a pure function
of direction.**

```ts
planet.heightAt(unitDirection) -> radius
```

Nothing in the game raycasts against the ground. The character controller, the
villagers, the prop scatterer and the camera's floor check all call that
function and get an exact answer in about 2µs. The terrain mesh is generated
from the same function, so the visual surface and the collision surface are the
same surface by construction.

The character is stored as a **unit direction plus a height above the ground**,
never as a world position:

- Walking rotates the direction about the axis perpendicular to the local up and
  the heading — a great-circle arc. The character therefore cannot drift off its
  shell or accumulate float error however far it walks.
- Jumping and gravity act only on the height, entirely decoupled from horizontal
  motion.
- World position is recovered as `dir * (heightAt(dir) + height)`.

`src/util/sphere.ts` holds the primitives. Note that `moveOnSphere` takes an
explicit radius: passing a unit direction and letting it infer the radius from
the vector length is a mistake that makes the player move 22× too fast, which is
exactly the bug this signature now prevents.

### The camera

There is no global "north" on a planet you can walk all the way around, so the
camera's heading is stored as a **tangent vector**, not a yaw angle. Every frame
it is parallel-transported into the player's current tangent plane, which keeps
the view continuous as the ground curves away and means the horizon never tilts
or snaps. Pitch stays a plain scalar measured from that plane, and the camera's
own up vector is set to the player's up before each `lookAt`.

Collisions are resolved **after** smoothing, never before — easing toward a
corrected target still lets the camera dip through a wall on the way there.

### Rendering budget

The scene runs at roughly **100 draw calls and 360k triangles** on the high
preset, and **59 calls / 146k triangles** on low. The techniques that get it
there:

- **Vertex-coloured props.** Every prop bakes its colours into a vertex-colour
  attribute, so a tree with a brown trunk and three green tiers is one geometry
  with one material — which is what makes the next two items possible.
- **Merged static scenery.** All the buildings in a settlement are merged into a
  single geometry. A village is 2 draw calls (fill + outline) regardless of how
  many houses it has, and its tight bounding sphere means settlements on the far
  side of the planet frustum-cull for free.
- **Instanced everything else.** Trees, rocks, grass, mailboxes and the entire
  villager crowd are `InstancedMesh`es. The villagers are animated by rewriting
  their instance matrices, which is why a crowd costs 6 draw calls and no
  skeletons.
- **Instance-level LOD.** Every 150ms the scatter field repacks each instance
  buffer so only props within their draw distance are submitted, and lowers
  `count` to match. Grass has a 30-unit radius; trees get 60.
- **Inverted-hull outlines.** One extra draw call per object rather than a
  full-screen post-process pass — which matters on phones.
- **A shadow camera that follows the player.** A frustum wide enough for the
  whole planet would spend almost all its resolution on ground you cannot see.

### Toon shading

`MeshToonMaterial` with a hand-built gradient ramp: a 1×N texture sampled with
`NEAREST`, so lighting quantises into flat bands. The darkest band is held well
above zero so shadows stay coloured rather than crushing to black.

### Day and night

The sun orbits on a tilted axis, but the sky palette is driven by the sun's
elevation **above the player's own horizon**, not by the global clock. On a world
this small, walking far enough is itself a change of time of day: two players on
opposite sides see noon and midnight at the same moment, and the terminator
sweeps past you as you travel. Street lamps light up as your local night falls.

### Audio

There are no sound files in this project. The ambient bed, footsteps, delivery
chime and reaction blips are all synthesised at runtime from oscillators and one
procedurally-filled noise buffer. The "music" never loops audibly because the
arpeggio is re-rolled from a pentatonic scale every couple of seconds. The audio
context is created on the first user gesture, as autoplay policy requires.

---

## Multiplayer

Two transports implement one interface (`src/net/transport.ts`); which one runs
is a single environment variable.

### Supabase Realtime (default — nothing to host)

`VITE_NET_TRANSPORT=supabase`. One channel carries `broadcast` for position and
emoji (with `self: false`) and `presence` for the roster — presence is what makes
leave events reliable, since broadcast alone cannot tell you somebody closed
their tab.

### Socket.io (self-hosted)

`VITE_NET_TRANSPORT=socket`, with `npm run server`. A pure relay: it holds
identity and last-known state so a joining client can be told who is already
here, but simulates nothing. Deploy it anywhere that runs Node (Fly, Railway,
Render); it exposes `/health`.

### The wire format

Position updates go out at 10Hz as a unit direction, a tangent facing vector, a
height and a speed:

```jsonc
{ "id": "…", "t": 1727, "d": [x,y,z], "f": [x,y,z], "h": 0, "s": 4.6, "c": 1 }
```

Sending a direction rather than a world position is both smaller and more
correct: the receiver re-derives the exact ground height from its own copy of the
terrain function, so remote couriers always stand precisely on the ground instead
of trusting a number sampled on someone else's frame.

Remote avatars are rendered **130ms in the past** and interpolated between the
two snapshots that straddle that render time. Rendering slightly behind is what
buys the smoothness: there is almost always a *later* snapshot to move toward, so
avatars glide instead of extrapolating into walls and snapping back. Past the
newest snapshot the rig holds its last pose rather than extrapolating — a brief
stall reads far better than a rubber-band.

---

## Database

Supabase Postgres stores courier profiles (name, outfit, hat, skin) and the
leaderboard. The schema is in `supabase/migrations/`.

The security model is the interesting part. This is a browser game with no
sign-in, so **the anon key is public by definition** — it ships in the bundle.
Therefore:

- `public.couriers` has RLS enabled **with no policies at all**, and all
  privileges are revoked from `anon`. There is no direct table access.
- Every read and write goes through a `SECURITY DEFINER` function —
  `upsert_courier`, `get_courier`, `leaderboard` — which validates, trims and
  clamps everything it is given. The table also carries `CHECK` constraints as a
  second line of defence.
- `upsert_courier` keeps the **best** of each score column rather than the
  latest, which makes it idempotent and safe to call after every delivery.
- `leaderboard` deliberately does not return session ids.

Session ids are client-generated UUIDs; knowing your own id is what authorises
writing your own row. That is the standard anonymous-session trade-off, and it is
the reason Supabase's linter will report "RLS enabled, no policy" and
"SECURITY DEFINER function executable by anon" for this project. Both are
intentional: the functions *are* the public API, and the table is sealed behind
them.

Two ids are tracked, on purpose:

- `tpc.profile.v1` in **localStorage** — stable per browser, keys the database row.
- `tpc.session.v1` in **sessionStorage** — one per tab, keys network presence.

Two tabs are two couriers in the world, but the same person on the leaderboard.

Score writes use a **trailing-edge** throttle: a call inside the quiet window is
not dropped, it replaces the pending payload and flushes when the window opens.
A leading-edge throttle silently loses the player's last delivery, which is
exactly the one they care about.

### Configuration

Copy `.env.example` to `.env`:

```ini
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_…
VITE_NET_TRANSPORT=supabase   # supabase | socket | off
VITE_SOCKET_URL=http://localhost:8787
```

Every backend call degrades to a no-op when these are unset, so the game runs
identically with an empty `.env` — just single-player, with cosmetics saved to
localStorage only.

---

## Project layout

```
src/
  config.ts            All tuning constants in one place
  main.ts              Orchestration: build the world, run the frame loop
  core/
    Engine.ts          Renderer, scene, frame loop, quality presets
    Loader.ts          Task runner behind the progress bar
  util/
    sphere.ts          Great-circle movement, tangent transport, orientation
    noise.ts           Seeded 3D simplex + fBm + ridged multifractal
    rng.ts             Seeded PRNG (the planet is identical for every player)
  world/
    Planet.ts          The analytic terrain field and its meshes
    zones.ts           Five biomes and their blending
    props.ts           Every prop, built from primitives
    Scatter.ts         Instanced placement + distance LOD
    Settlements.ts     Town, hamlets, works, depot, mailboxes, colliders
    Sky.ts             Sky dome, clouds, stars
    DayCycle.ts        Sun orbit and the lighting keyframe table
  player/
    Controller.ts      Sphere-relative character controller
    FollowCamera.ts    Tangent-heading orbit camera
    Courier.ts         Procedural rig and animation
    Input.ts           Keyboard, mouse, touch → one struct
  gameplay/
    Delivery.ts        The loop, the beacon, the compass, scoring
    NPC.ts             Instanced villager crowd
    dialogue.ts        Names and flavour text
  net/
    transport.ts       Transport interface + identities
    SupabaseTransport.ts / SocketTransport.ts
    RemotePlayers.ts   Interpolated remote avatars
    backend.ts         Profiles and leaderboard
  fx/
    toon.ts            Palette + gradient ramps
    outline.ts         Inverted-hull outlines
    Particles.ts       Confetti
    EmojiField.ts      Floating reactions
  ui/
    ui.ts              DOM HUD driven by store subscriptions
    touch.ts           Virtual stick, look pad, buttons
server/                Optional Socket.io relay
supabase/migrations/   Database schema
```

---

## Deviations from the brief

Worth stating plainly:

- **No Blender or Houdini assets.** Every mesh in the game is generated from
  primitives in TypeScript at load time, and every sound is synthesised. This was
  a constraint of the build environment, not a preference — but it does mean the
  game downloads ~267KB gzipped total and needs no CDN. `Courier.ts` documents
  the seam: a rigged GLB can replace the procedural rig by implementing the same
  small public surface (`root`, `setCosmetics`, `setPose`, `playGesture`,
  `setCarrying`) against an `AnimationMixer`, and nothing outside that file knows
  how the rig works.
- **React Three Fiber was not used.** The brief listed it as optional; plain
  Three.js with a vanilla Zustand store keeps the bundle smaller and the frame
  loop explicit.
- **GSAP is used sparingly** — screen fades, the objective card pop, the score
  bump — rather than for anything in the simulation. Note that GSAP runs on
  `requestAnimationFrame`, which browsers throttle to a standstill in a
  background tab, so UI state changes are committed on plain timers and the
  loader never awaits rAF alone. Otherwise a player who switched tabs while the
  world generated would come back to a frozen progress bar.

## Performance notes

Targets a stable 60fps on mid-range laptops and recent phones. If it dips, press
`G` or use Settings → Graphics → Low, which drops shadows, outlines, device pixel
ratio and scatter draw distance for roughly a 2.4× reduction in triangles and
draw calls.

World generation takes about 1.5s on a desktop: an icosphere of 32,492 welded
vertices, ~2,400 scattered props and five settlements, all behind a progress bar
that yields to the browser between steps.
