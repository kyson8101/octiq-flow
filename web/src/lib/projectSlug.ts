/** The project's label, said as an address.
 *
 *  The chat URL names its project by LABEL, not id — a link that reads
 *  #/p/octiq-flow says where it goes, where a UUID says nothing. A slug rather
 *  than the raw label because labels carry spaces and parentheses
 *  ("pandahrms-sso (Legacy)"), which percent-encode into line noise.
 *
 *  Lower-cased so the address survives retyping, with every run of
 *  non-alphanumerics folded to one dash. Two labels that collide here are the
 *  same address — which is why the backend refuses to let two projects share
 *  a slug. */
export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
