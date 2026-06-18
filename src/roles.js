// Agent roles — the "job titles" of the people in the virtual office.
//
// Each role stands for a group of the skills this workspace already has
// (discover, code-review, security-review, verify, ef-migrations, ship, …).
// The Agent World view paints each agent with its role: a role emoji now, and
// later a Codex-generated avatar image (drop a PNG at
// `src/assets/agents/<roleId>.png` and it is used automatically — see the World
// avatar code). The matching image-generation prompts live in docspace:
// `ideaverse/octiq-agent-roles-avatars.md`.
//
// A role is decided two ways:
//   1. An explicit override (the future orchestrator calls setAgentRole(id, …)
//      when it hands a card to an agent), OR
//   2. a keyword guess from the agent's title / last line, then a stable
//      per-id fallback so every desk still gets a consistent role.

/** The role catalog. `skills` is the set of workspace skills the role stands
 *  for (kept for the docspace prompts + future assignment). `emoji` is the
 *  stop-gap avatar; `color` tints the role chip. */
export const ROLES = [
  {
    id: "orchestrator",
    label: "Orchestrator",
    emoji: "🧭",
    color: "#fbbf24",
    skills: ["discover", "slice", "status", "close"],
    blurb: "Reads the request, splits it into cards, assigns the work.",
  },
  {
    id: "architect",
    label: "Architect",
    emoji: "📐",
    color: "#a78bfa",
    skills: ["Plan", "spec", "visualise", "discover"],
    blurb: "Designs the approach and writes the behaviour spec.",
  },
  {
    id: "senior-dev",
    label: "Senior Dev",
    emoji: "👩‍💻",
    color: "#8fbfa8",
    skills: ["execute", "card-commit"],
    blurb: "Builds the feature card end to end.",
  },
  {
    id: "frontend",
    label: "Frontend",
    emoji: "🎨",
    color: "#f472b6",
    skills: ["lucid-refactor", "lucid-ui", "openapi-react-query-refactor"],
    blurb: "Builds and polishes the UI.",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    emoji: "🔍",
    color: "#60a5fa",
    skills: ["code-review", "pr-approver-review", "simplify"],
    blurb: "Reviews the diff for bugs and cleanliness.",
  },
  {
    id: "security",
    label: "Security",
    emoji: "🛡️",
    color: "#de8d85",
    skills: ["security-review"],
    blurb: "Audits auth, input, secrets, and tenant isolation.",
  },
  {
    id: "qa",
    label: "QA",
    emoji: "✅",
    color: "#85c79a",
    skills: ["verify", "lint-gate", "playwright-war-room"],
    blurb: "Runs the build, tests, and checks the feature really works.",
  },
  {
    id: "dba",
    label: "Database",
    emoji: "🗄️",
    color: "#22d3ee",
    skills: ["ef-migrations", "restore-db", "swap-perf-db"],
    blurb: "Owns migrations and the database.",
  },
  {
    id: "devops",
    label: "DevOps",
    emoji: "🚀",
    color: "#fb923c",
    skills: ["ship", "pack-performance-deploy", "pr"],
    blurb: "Ships the build and opens the PR.",
  },
  {
    id: "researcher",
    label: "Researcher",
    emoji: "🔬",
    color: "#94a3b8",
    skills: ["deep-research"],
    blurb: "Gathers sources and writes a cited report.",
  },
  {
    id: "support",
    label: "Support",
    emoji: "🎫",
    color: "#d4b06a",
    skills: ["triage-ticket", "discover-ticket", "resolve-ticket"],
    blurb: "Triages tickets and writes the customer resolution.",
  },
];

/** Fast lookup by id. */
export const ROLE_BY_ID = new Map(ROLES.map((r) => [r.id, r]));

// Keyword rules, checked in order — first match wins. The text is the agent's
// title + last line, lower-cased. Tuned so the obvious skills land on the
// obvious role; anything unmatched falls back to a stable per-id pick.
const RULES = [
  { re: /security|owasp|vuln|secret|tenant/, id: "security" },
  { re: /review|pr-approver|simplify|\bpr\b review/, id: "reviewer" },
  { re: /verify|\bqa\b|\btest|playwright|lint-gate|coverage/, id: "qa" },
  { re: /migration|ef-migrations|\bdb\b|database|restore-db|swap-perf/, id: "dba" },
  { re: /lucid|frontend|\bui\b|react|openapi|component/, id: "frontend" },
  { re: /ship|deploy|release|pack-performance|bundle/, id: "devops" },
  { re: /research|deep-research/, id: "researcher" },
  { re: /ticket|triage|resolve-ticket|discover-ticket|support/, id: "support" },
  { re: /discover|slice|\bspec\b|\bplan\b|visualise|architect/, id: "architect" },
  { re: /orchestrat|dispatch|manager|coordinat/, id: "orchestrator" },
  { re: /execute|implement|build|feature|card|codex|claude/, id: "senior-dev" },
];

// Roles a stable fallback may pick from (skip the manager-ish ones so a random
// worker never looks like the orchestrator).
const FALLBACK = ["senior-dev", "frontend", "qa", "reviewer", "architect"];

// Explicit overrides set by the orchestrator when it assigns a card to an agent.
const overrides = new Map(); // ptyId -> roleId

/** Stable index into a list from a string (same hash the World uses). */
function hashIndex(str, mod) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** Pin an agent to a role (used later by the orchestrator on assignment). */
export function setAgentRole(id, roleId) {
  if (ROLE_BY_ID.has(roleId)) overrides.set(id, roleId);
}

/** Drop an agent's override (e.g. when its terminal closes). */
export function clearAgentRole(id) {
  overrides.delete(id);
}

/** A generated flat-vector standing character for a role, as an SVG data URI.
 *  This is the built-in art used when no PNG exists at /assets/agents/<id>.png —
 *  a drawn little person in the role's color holding the role emoji as a prop,
 *  so an agent never shows as a bare emoji. A real PNG always takes precedence.
 */
export function roleSvgDataUri(role) {
  const c = role?.color || "#8fbfa8";
  const emoji = role?.emoji || "🧑‍💻";
  // Explicit width/height (not just viewBox) so it rasterizes to a known size —
  // a WebGL texture reads image.width/height to set the sprite aspect.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='74' height='104' viewBox='0 0 74 104'>
<rect x='27' y='66' width='8' height='30' rx='4' fill='#34343c'/>
<rect x='39' y='66' width='8' height='30' rx='4' fill='#34343c'/>
<ellipse cx='31' cy='97' rx='7' ry='3' fill='#22222a'/>
<ellipse cx='43' cy='97' rx='7' ry='3' fill='#22222a'/>
<rect x='14' y='47' width='9' height='22' rx='4.5' fill='${c}'/>
<rect x='51' y='47' width='9' height='22' rx='4.5' fill='${c}'/>
<rect x='20' y='44' width='34' height='31' rx='12' fill='${c}'/>
<circle cx='37' cy='27' r='15' fill='#f2c9a5'/>
<path d='M22 27 a15 15 0 0 1 30 0 q-15 -11 -30 0 z' fill='#2c2c34'/>
<rect x='28' y='25' width='8' height='6' rx='2' fill='#dfe7ee' stroke='#2c2c34' stroke-width='1.3'/>
<rect x='39' y='25' width='8' height='6' rx='2' fill='#dfe7ee' stroke='#2c2c34' stroke-width='1.3'/>
<line x1='36' y1='28' x2='39' y2='28' stroke='#2c2c34' stroke-width='1.3'/>
<circle cx='32' cy='28' r='1.3' fill='#2c2c34'/>
<circle cx='43' cy='28' r='1.3' fill='#2c2c34'/>
<text x='50' y='72' font-size='17'>${emoji}</text>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Decide an agent's role: explicit override → keyword guess → stable fallback.
 *  `t` is a terminalSnapshot item ({ id, title, lastSent, ... }). Always returns
 *  a role object from ROLES. */
export function roleForAgent(t) {
  const pinned = overrides.get(t.id);
  if (pinned) return ROLE_BY_ID.get(pinned);

  const text = `${t.title || ""} ${t.lastSent || ""}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.re.test(text)) return ROLE_BY_ID.get(rule.id);
  }
  return ROLE_BY_ID.get(FALLBACK[hashIndex(t.id, FALLBACK.length)]);
}
