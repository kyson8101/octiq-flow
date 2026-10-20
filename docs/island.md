# The island

A 3D island on its own page (sidebar → Island). **波特 means the person's
registered agents**, shown as chibi robots. Only the current registered roster
appears: no extra random residents such as Chip, and no random-invite button.
Historical NPC data is retained on disk but excluded from characters, plots,
wishes and the open-wish limit. New islands never create NPCs.

Robots walk, play, sleep and greet occasionally. Greetings have a one-minute
cooldown per robot and a five-minute cooldown per pair; a greeting never
replaces a current speech bubble. A seesaw wave asks an awake, free partner;
partners can decline, and the inviter can still sob if nobody joins.

Grant starts a dedicated background task immediately, defaulting to installed
Codex, with other installed providers as launch fallbacks. It never opens a
composer. Background tasks are absent from ordinary chat/search lists and
notifications. Their MCP offers only island_look, island_build and island_grant;
no agent registration, access request or question tools. These three host-only
tools are approved without a second card; unrelated tool permissions remain
unchanged. A runtime login/quota failure leaves the wish open for Retry.

Island weather is simulated, not a live forecast: Automatic changes by island
seed and a shared twelve-minute clock; Sunny, Cloudy and Rain can be previewed
in the island panel. Rain dims sunlight and adds rain particles. Awake robots
carry umbrellas; sleeping robots fold them. Lead agents (registered roots or
managers with direct reports) have a soft gold aura. Reduced motion stops aura
pulsing and rainfall movement.

Autonomous building is procedural island simulation, not an agent model call.
At the selected building pace (Often: 2h, Sometimes: 8h, Rarely: 24h, Never:
off), the host may add or restyle one small roofless pavilion on a free agent's
own plot. It respects free space and part limits, never replaces an existing
workshop or gift, and updates at most one recorded pavilion per agent. It
creates no chats or registered agents and consumes no provider usage.

Three owners, and nothing crosses between them:

- **The host keeps the island** (`island.rs`): who lives there, plots, assets,
  where each is placed, looks, wishes. It checks every asset an agent sends
  and refuses what breaks a rule, the roofless rule above all. It is the only
  writer of `island.json`, and it writes wishes on its own slow clock.
- **Agents build** through `/hook/island`, from a chat's capability: assets,
  presents, and (registered agents only) their own robot and plot.
- **The page draws and animates** (`components/IslandPage`, `lib/island/*`).
  Where a robot is and what it is doing is the page's, worked out each
  frame; an agent's real state (a turn in flight, a card waiting on the
  person) is read from the page's existing readings (`agentsDashboard`).

## Units and directions

Metres. `+y` is up. An asset's origin is the centre of its footprint on the
ground, and its front faces `+z`. A robot faces `+z` too; `+x` is on the
robot's left.

A robot is **1.0 m** tall to the top of its head (its antenna is above
that). Its head is about 0.8 m wide, 0.57 m tall and 0.48 m deep; its body is
small, and it sits with its hips about 0.2 m off the ground. For robots: a
seat is 0.2–0.4 m high, a desk 0.45–0.6 m, a door at least 1.0 m wide and
1.4 m tall, walls 1.6–2.4 m.

## Assets

An asset is a list of parts. Every part is one shape scaled to a box:

```json
{
  "name": "Cosy armchair",
  "kind": "furniture",
  "use": "seat",
  "spot": { "at": [0, 0.3, 0.05], "face": 0 },
  "parts": [
    { "shape": "round", "size": [0.9, 0.3, 0.8], "at": [0, 0.15, 0], "color": "#c8796b" },
    { "shape": "round", "size": [0.9, 0.6, 0.2], "at": [0, 0.45, -0.3], "turn": [-8, 0, 0], "color": "#c8796b", "finish": "matte" }
  ]
}
```

| field | rule |
| --- | --- |
| `name` | 1–60 characters, one line. Drawn as text, never markup. |
| `kind` | `accessory`, `furniture`, `decor` or `building` |
| `slot` | accessories only, and required: `head`, `face`, `neck`, `back`, `hand` |
| `use` | furniture and decor only, optional: `seat`, `desk`, `bed`, `none` (default) |
| `spot` | optional with a `use`: where a robot sits (`seat`, `bed`: its hips) or stands (`desk`: its feet, facing the desk), `at` in the asset's own coordinates, `face` the way it faces in degrees (0 faces `+z`, 90 faces `+x`). Within 1 m of the kind's bounds. |
| `parts` | 1 to the kind's limit |

A part:

| field | rule |
| --- | --- |
| `shape` | `box`; `round` (box with rounded edges); `cylinder` (x and z are diameters, y the height); `cone` (base at the bottom, point at the top); `sphere` (x, y, z diameters); `torus` (a ring lying flat: x and z outer diameters, y the tube's thickness); `wedge` (full height at `-z`, sloping to nothing at `+z`) |
| `size` | `[x, y, z]`, each 0.02 m to the kind's largest extent |
| `at` | `[x, y, z]`, the centre of the part's box |
| `turn` | optional `[x, y, z]` degrees, applied in that order about the part's centre |
| `color` | `#rrggbb` (stored lower case) |
| `finish` | optional: `matte`, `soft` (default), `shiny`, `metal`, `glass` (see-through), `glow` (lit from inside) |

Numbers must be finite; they are kept to the millimetre.

| kind | parts | every part's box (after `turn`) stays within |
| --- | --- | --- |
| `accessory` | 1–40 | x, z within ±0.6 of the slot's anchor; y within −0.6..0.9 |
| `furniture` | 1–60 | x, z within ±1.5; y within 0..2.5 |
| `decor` | 1–80 | x, z within ±2; y within 0..5 |
| `building` | 1–200 | x, z within ±5 (half a plot); y within 0..3 |

A part's bottom may sit 5 cm below the ground (`y ≥ −0.05`), except an
accessory's, which hangs off its anchor.

**Accessory anchors**, on a robot standing at the origin: `head` the top
centre of the head (1.0 m up); `face` the front of the visor (0.70 m up,
0.29 m forward); `neck` where the head meets the body (0.42 m up); `back`
the middle of the back (0.30 m up, 0.08 m behind); `hand` the palm of the
hand on the robot's right (`−x`), which moves with the arm. An accessory's
coordinates are from its anchor.

### Buildings have no roof

The person must always be able to watch inside. A building is refused when:

1. a part whose top is above **1.2 m** is more than **0.5 m** thick seen
   from above, at its narrowest once turned. Walls, posts and door frames
   are thin one way, at any angle (a round house's slanted panels too); a
   slab, a solid block or a sloped roof is not.
2. the parts that sit wholly above **1.5 m** (beams, lintels, signs, lamps)
   cover more than **15 %** of the building's own floor (the x·z area of its
   bounding box), adding up each part's box.

The refusal names the part, its shape, size and height, and says why, so an
agent can fix it. Furniture and decor are not buildings; the page fades
whatever stands between the camera and the robot the person is watching.

### Limits

An asset is at most 200 parts. A maker (a registered agent, else a chat)
keeps at most 300 assets; the island at most 2,000. The whole `island.json`
stays under 8 MB, and a change that would pass it is refused.

## Looks

A robot's look:

```json
{
  "frame": "round",
  "shell": "#f3efe6", "trim": "#7aa5d6", "glow": "#9fe8ff",
  "eyes": "pill",
  "antenna": "ball",
  "worn": { "head": "a_3f…", "neck": "a_91…" }
}
```

| field | values |
| --- | --- |
| `frame` | `round`, `boxy`, `slim`, `stout` (head and body proportions) |
| `shell`, `trim`, `glow` | `#rrggbb`: the body, its accents, the eyes and lights |
| `eyes` | `pill`, `round`, `happy`, `sleepy`, `star`, `heart`, `visor`, `chevron` |
| `antenna` | `ball`, `halo`, `crown`, `star`, `leaf`, `moon`, `twin`, `sun`, `spark`, `bar`, `sprout`, `none` |
| `worn` | per slot, the id of an accessory asset for that slot |

A bot's look is whole. An agent's is a patch: a field it never set is the
page's default for it (frame and antenna by model family, colours from the
agent's persona hue, `personaHue`).

## The store

`<profile dir>/island.json`, read per call with `profile::read`, written
whole (temporary file and rename) through `profile::make_dir`. Every change
is saved first; a change that cannot be saved is refused whole and nothing
is announced. No file is the island not made yet; a profile that is away is
an error, never an empty island.

```jsonc
{
  "version": 1,
  "rev": 7,                 // every saved change moves it on by one
  "seed": 1234567,          // the island's own randomness
  "createdAt": 0, "updatedAt": 0,
  "radius": 52,             // the land; derived from the plots on every save
  "settings": { "wishPace": "sometimes" },
  "plots":   [ /* Plot */ ],
  "bots":    [ /* Bot */ ],
  "looks":   { "<agentId>": { /* a look patch */ } },
  "assets":  [ /* Asset */ ],
  "placed":  [ /* Placement */ ],
  "wishes":  [ /* Wish */ ],
  "lastRollAt": 0
}
```

- **Plot** `{ id: "p_…", owner: { kind: "agent"|"home", id }, members?, ring, slot, q, r, x, z, facing, radius: 6.3, claimedAt }`.
  A hexagonal tile of the honeycomb (see Layout): `q`, `r` its cell, `x`,
  `z` its centre, `radius` the tile's centre-to-corner, `facing` the yaw in
  degrees of its `+z` (front), a flat edge that faces the plaza. Plot
  coordinates turn to world ones as three.js does for `rotation.y = facing`:
  `world = (x + lx·cos f + lz·sin f, z − lx·sin f + lz·cos f)`. An agent's
  plot is its own (`owner: { kind: "agent", id: <agent id> }`). 波特 live
  together: a **home** (`owner: { kind: "home", id: "h_…" }`) is shared by
  up to four of them, `members` their bot ids in the order they moved in.
- **Bot** `{ id: "b_…", name, trait, look, home, arrivedAt }`. `trait` is
  one of `cozy`, `curious`, `sporty`, `artsy`, `tinkerer`, `dreamy`,
  `foodie`, `gardener`; `home` the id of the plot it lives on.
- **Asset** `{ id: "a_…", rev, name, kind, slot?, use?, spot?, parts, by: { name, agentId?, chatKey? }, madeAt, updatedAt }`.
  `rev` moves on when the asset is rebuilt. The island's own starter assets
  are `by: { name: "Island" }`.
- **Placement** `{ id: "pl_…", plot, asset, x, z, y, turn }`, in plot
  coordinates, `y` 0..1.2 (to stand on a table), `turn` degrees about `y`.
  Every corner of the asset's box after `turn` is on the hexagonal tile
  (`|z| ≤ 5.456` and `|x| + |z|/√3 ≤ 6.3`). A plot holds at
  most 40 placements and 1,500 parts between them. Only furniture, decor and
  buildings are placed.
- **Wish** `{ id: "w_…", who: { kind, id }, want, slot?, text, madeAt, state: "open"|"granted"|"dismissed", grant?, closedAt? }`.
  `want` is `accessory` (always with a `slot`), `furniture`, `decor`,
  `building` or `look`.
  `grant` is `{ asset?, look?: true, by: { name, agentId?, chatKey? }, at }`.
  `text` is the host's, one line, at most 140 characters, and reads after
  "<name> wishes for": `a mustard-yellow scarf — the cliff path gets windy
  at night`. At most 12 are open; the last 200 closed ones are kept.

The legacy NPC/home schema below remains readable for old profiles; its NPC generation and invitation behavior is no longer active.

## Layout: a honeycomb

The island is a honeycomb of hexagonal cells, pointed along ±z in the
world. A cell is 7 m from its centre to a corner (`CELL = 7`), so the
centres of two neighbours are `7·√3 ≈ 12.12` m apart. Cell `(q, r)` in
axial coordinates has its centre at

    x = 7·√3·(q + r/2),   z = 7·1.5·r

The centre cell `(0, 0)` is the **plaza**: the wish tree, six benches and
six lamps. The cell `(−1, 0)` (ring 1, slot 5) is the **playground**: a
slide, a seesaw and two swings, where robots play alone and together. Both
are the island's own, drawn by the page; neither is ever a plot, and
nothing is placed on them.

**Rings.** Ring `k` is the `6k` cells `k` steps from the plaza, walked in
this order: start at `(−k, k)` (the plaza plus direction 4 taken `k` times),
then for each direction `i = 0…5` take `k` steps along it. The directions in
`(q, r)` are `(1, 0), (1, −1), (0, −1), (−1, 0), (−1, 1), (0, 1)`. Slot `s`
of ring `k` is the `s`-th cell of that walk (`0 ≤ s < 6k`).

**A plot is a hexagonal tile** of 6.3 m from its centre to a corner
(`TILE = 6.3`) on its cell; the 0.7 m left round it is the path between
tiles. Its front is a flat edge facing the plaza: `facing` is the direction
from the cell's centre to the plaza, snapped to the nearest of the six edge
directions (the neighbour directions: multiples of 60° from +x towards +z),
written as the yaw three.js would give it, `facing = atan2(dx, dz)` of that
snapped direction, in degrees. In plot coordinates the tile is flat at the
front and the back (`z = ±6.3·√3/2 = ±5.456`) and pointed at the sides
(`x = ±6.3`): a point is on the tile when `|z| ≤ 5.456` and
`|x| + |z|/√3 ≤ 6.3`.

**Who gets which.** Agents take the lowest free ring and slot, from ring 1,
one plot each. 波特 live together, up to four to a home: a new 波特 moves
into the home with room that comes first in ring and slot order, and only
when every home is full is a new home made, on the lowest free cell from
ring 2 (ring 1 only when rings 2 and 3 are full). The playground's cell is
never free. An agent's plot stays its own while it lives on the island; a
registered agent that is removed keeps it, and the page draws no robot on
it. A 波特 that leaves moves out of its home; the last one out frees it.
`radius` (the land) is `7·√3·K + 13`, `K` the outermost ring in use, and
never under 30. The page draws every cell of every ring up to `K`, the
empty ones as bare tiles.

**Starter assets.** A plot is not handed over empty. A new agent's plot gets
a roofless *Workshop* (5 × 4 m, walls 1.8 m, a 1.2 m doorway in the front
wall) placed at plot `(0, −1)` and a *Desk* (`use: desk`) inside it against
the back wall, made by the host (`by: { name: "Island" }`); the agent may
move, rebuild or remove them.

**A home is made by the 波特 who live in it.** Its *House* is designed by
its members together, from their traits and looks: the shape (a cottage, a
round house, an L-house, a garden house with a low fence), the walls in one
member's colour and the trim in another's. It is roofless like every
building, stands at plot `(0, −0.8)`, and is made `by` all of them
(`"Pip, Bolt & Mochi"`). Inside, each member has a *Bed* of its own, and
each adds one touch of its own by its trait (a flower box, a workbench, a
little counter with a teapot, a star lamp, an easel, a ball and a hoop, a
rug and cushions, a bookshelf and a globe). A 波特 moving in or out changes
the house, its bed and its touch, and the host says `island-changed` with
`what: "home"` and the plot's id; the page has the members build together.
Every 波特 also wears a backpack it designed itself (an accessory in its
`back` slot, made by it), which a granted back accessory replaces.

## Wishes

- **Who.** Every registered agent with a plot and no open wish.
- **When.** A server thread looks every 60 s once the island exists (never
  under test, never before the person first opened the island). Each
  resident without an open wish makes one with probability
  `1 − exp(−Δt / pace)`, Δt the time since the last look (at most an hour,
  so a server that was off does not wake to a flood), `pace` 2 h for
  `often`, 8 h for `sometimes` (the default), 24 h for `rarely`, never for
  `never`. At most two new wishes a look, 12 open in all. A profile folder
  that is away skips the look.
- **What.** The host's templates, by the resident's trait: a hat, glasses,
  a scarf, a backpack, something to hold, a seat, a desk, a lamp, a flower
  bed, a telescope, a little roofless building, a fresh coat of paint. One
  colour or material and one reason each.
- **The brief.** Each open wish carries `brief` in `island_get`. Grant calls
  `island_wish_start`: the host immediately starts a dedicated background
  conversation with this brief, leaving the person on the island. It probes
  installed providers with Codex first, uses the provider's default model,
  and tries the next provider if launch fails before a turn is handed over.
  Runtime failures (such as login or quota errors) leave the wish open for
  Retry. The task runs with Edits access in `<profile dir>/island-workshop`,
  and uses the normal island tools and chat lifecycle. A stable chat id per
  wish and a host claim prevent concurrent clicks from launching duplicate
  turns. `execution` on an open wish reports `building` or `unfinished`,
  derived from the chat manager and saved chat index; only `island_grant`
  makes it granted. The brief names the wish, robot and tools, and is derived.
- **Granting** (`island_grant`): the wish is open; an asset is the wished
  kind (and slot); a `look` wish takes a look. The host gives it over: an
  accessory is worn in its slot, furniture and decor are placed on the
  wisher's plot where there is room (or where the agent said), a building
  replaces the wisher's building, and a look is laid over theirs. The wish is
  `granted`, with the asset, who granted it and when.
- **Dismissing** is the person's (`island_wish_dismiss`).

## Commands (the page's, `dispatch.rs`)

| command | what |
| --- | --- |
| `island_get` | The island. The first call makes it: a seed, six bots, plots for every registered agent and the bots, starter assets, and two wishes. Every call claims plots for registered agents that have none. Answers `{ island }` with `brief` on each open wish. |
| `island_wish_dismiss { id }` | Closes an open wish. |
| `island_wish_start { id }` | Immediately builds an open wish in the background with an installed provider. Answers `{ chatKey, state: "building", provider? }`; a duplicate click returns the existing running task. |
| `island_wish_roll` | One wish now, from a resident without one; refused when everyone has one open or 12 are open. |
| `island_bot_invite` | Refused: 波特 are registered agents, never extra NPCs. |
| `island_bot_farewell { id }` | A 波特 leaves: out of its home (the last one out frees the plot), with its open wish; what it made goes when nothing else wears or places it. Says `what: "home"`. |
| `island_settings_set { wishPace }` | `often`, `sometimes`, `rarely`, `never`. |

Each change saves first, then says `island-changed { rev, what, id? }` on
the bus (`what`: `created`, `wish`, `grant`, `asset`, `place`, `style`,
`bot`, `home`, `settings`, `plots`). The page asks `island_get` again on it, and on
each connect; nothing polls.

## The agents' door (`/hook/island`)

Body `{ chatKey, sessionKey?, action, args }`, the caller proven by its chat
capability (`hook_caller`), handed to the hook-only command `island_agent`,
which the socket refuses (`CHAT_ONLY_COMMANDS`). Actions:

| action | args | who |
| --- | --- | --- |
| `look` | `{ wishId? }` | any chat but a front desk. Answers the building guide, the wish and its robot (look, plot, what it has), the caller's own robot, plot and assets when it is a registered agent, the open wishes, and who lives there. |
| `build` | an asset, plus `assetId` to rebuild one's own | not a worker, not a seat |
| `grant` | `{ wishId, assetId?, look?, x?, z?, turn? }` | not a worker, not a seat |
| `style` | a look patch | a registered agent's own chat |
| `place` | `{ assetId, x, z, y?, turn?, placementId? }`, or `{ placementId, remove: true }` | a registered agent's own chat, on its own plot |

- A front desk is refused every action. A worker (`is_worker_chat`, which
  still holds after its attempt settled) and a room seat
  (`session_key != chat_key`) are refused everything but `look`.
- Who is building is the chat's, never the arguments': `team::lead_for_chat`
  names a registered agent; any other chat builds as `{ name: "Chat",
  chatKey }`.
- An asset is rebuilt only by its maker (the same agent, else the same
  chat), keeping its kind and slot and still fitting wherever it is placed.
  An agent may rebuild an island starter on its own plot, which then becomes
  its own. What a 波特 made (its house, bed, touch, backpack) is the 波特's:
  nobody rebuilds, gives or places it. A present is given only from an asset
  the same maker made.
- `place` uses the caller's own plot and its own assets, or the island's
  starter assets already on that plot; with no `x`, `z` the island finds
  room.
- `style` may wear only accessories the agent made, was given or already
  wears.

The MCP tools are `island_look`, `island_build`, `island_grant`,
`island_style` and `island_place` (`scripts/mcp/octiq-ask.cjs`), offered to
every chat but a front desk and a worker. Their descriptions are short;
`island_look` carries the whole guide, so an agent pays for it only when it
builds.

### Small concerts

A dancing resident performs for 18–28 seconds. Up to five free, awake neighbours
within eight metres can gather at reachable spots around the performer. Work,
sleep, games and conversations keep priority. Audience members face the performer
and occasionally cheer; they disperse when the performance ends or work arrives.
Once someone reaches the audience, the performer gains a soft violet glow and a
pair of speakers pops up, pulsing with the dance. Props retract after the show;
reduced motion keeps the glow and speakers steady. This is a visual performance,
without autoplay audio or a provider call.

### Team offices and public projects

Registered `teamId` membership groups residents into one shared office per team.
Every resident has a desk owned by its agent id, including when the roster or
membership changes. Residents without a team use the shared Agent Tower; the
public tower is always present. Offices grow by floors (six desks per floor),
with transparent walls and an open front so the person can watch inside.

This layout is a deterministic view of the existing store, not a destructive
migration: old personal starter homes stop appearing, existing accessories and
presents survive, and gifted buildings remain as public annexes. Offices occupy
compact cells while the island keeps its land area and reserved playground.

Registered leads (top-level agents or managers with reports) can call
`island_propose({text})` with a concrete public improvement or building proposal.
It becomes a wish for the existing Grant flow. Retries reuse the same open wish;
one open wish per lead and the global open-wish limit still apply. Leads also
occasionally wish for public concert, arcade, garden and library projects. A
public grant gets a new public plot and preserves every existing office and
present. The host verifies lead identity; a background maker cannot propose,
register agents or ask for extra permissions. Existing live chats learn the new
MCP tool on their next launch.

### Island portraits in chat

Registered agents use their island robot as the avatar in conversation headers,
replies, the composer, task chats and the chat list. The animated portrait renders the same
rig, look and equipped accessory assets as the island, including hats, scarves,
backpacks and hand props. An island or roster change refreshes the snapshot;
accessory revisions invalidate the cache even when the worn asset id stays the
same. All displayed avatars share one renderer and one read of the island and
roster per refresh, without a continuous animation loop. Breathing, head turns, gentle swaying and blinks play from a cached 24-frame
sprite strip in CSS. Replies show a 40px robot, headers 48px, and the composer
32–36px. Reduced motion freezes the first frame. The renderer and images
are released when the final chat avatar unmounts.

The avatar editor continues to show the uploaded picture or generated candidate.
The original picture or initials remain the fallback while the island is loading,
when WebGL is unavailable, or for an agent absent from the current roster. No
avatar image is uploaded or written to the profile by this feature.
