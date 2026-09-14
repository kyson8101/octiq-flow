import { flushSync } from "react-dom";

let active: ViewTransition | undefined;
let revision = 0;

/** One transition owns the page. A newer gesture wins even if the previous
 * snapshot callback has not run yet. State changes never wait for animation. */
export function transitionZen(kind: "enter" | "exit" | "options", update: () => void) {
  const current = ++revision;
  active?.skipTransition();
  active = undefined;
  const root = document.documentElement;
  delete root.dataset.zenTransition;
  let applied = false;
  const commit = () => {
    if (current !== revision || applied) return;
    applied = true;
    flushSync(update);
  };
  const finish = () => {
    if (current !== revision) return;
    active = undefined;
    delete root.dataset.zenTransition;
  };

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !document.startViewTransition) {
    commit();
    // Older browsers still settle gently; reduced-motion users get an
    // immediate update with no travel, blur, or delayed interaction.
    if (!reduced) document.querySelector<HTMLElement>(".app .main")?.animate?.(
      [{ opacity: 0.75 }, { opacity: 1 }],
      { duration: 320, easing: "ease-out" },
    );
    return;
  }

  root.dataset.zenTransition = kind;
  try {
    active = document.startViewTransition(commit);
    // Skipping a snapshot rejects ready but still runs the state update.
    void active.ready.catch(() => {});
    void active.finished.then(finish, () => { commit(); finish(); });
  } catch {
    commit();
    finish();
  }
}

export function cancelZenTransition() {
  revision++;
  active?.skipTransition();
  active = undefined;
  delete document.documentElement.dataset.zenTransition;
}
