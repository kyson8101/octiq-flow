// The single way into app-wide and project configuration. Project rows lead to
// the focused project sheet instead of leaking one shortcut per project into
// unrelated chat menus.
//
// Choosing applies at once and there is no Save. That is the same rule the
// project sheet follows: on a phone, a Save button you can lose by swiping is
// worse than a change you can undo by choosing again.
import { useState } from "react";

import { askPermission, permissionNow, setOn, supported } from "../lib/notify";
import * as push from "../lib/push";
import { applyTheme, preview, THEMES } from "../lib/themeStore";
import type { ProjectDetail } from "./ProjectSettings";
import { ProjectAvatar } from "./ProjectAvatar";
import { MemoryVaultSettings } from "./MemoryVaultSettings";
import { AgentsSettings } from "./AgentsSettings";

export type SettingsSection = "projects" | "agents" | "notifications" | "appearance" | "memory";

const projectNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function compareProjectNames(left: ProjectDetail, right: ProjectDetail): number {
  return projectNameCollator.compare(left.name, right.name)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

export function Settings({ current, onPick, notify, onNotify, projects, onProject, agentsMode = false, onAgentsMode, initialSection = "projects", onClose }: {
  /** The chosen theme's id. Held by App so the sheet can close and reopen
   *  without forgetting, and so nothing re-reads localStorage to draw a tick. */
  current: string;
  onPick: (id: string) => void;
  /** Whether desktop notifications are switched on. Held by App for the same
   *  reason as the theme: the thing that FIRES them has to read it too. */
  notify: boolean;
  /** `viaPush` says the SERVER is now doing the announcing, which means the
   *  page must stop — otherwise one moment draws two banners. */
  onNotify: (on: boolean, viaPush: boolean) => void;
  /** Project configuration lives here instead of being repeated throughout
   *  the chat menus. Shelved projects stay reachable too. */
  projects: ProjectDetail[];
  onProject: (id: string | "new") => void;
  /** Agents mode: New chat becomes New task, handed to a registered agent. */
  agentsMode?: boolean;
  onAgentsMode?: (on: boolean) => void;
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const choose = (id: string) => {
    applyTheme(id);
    onPick(id);
  };

  // What the browser has decided, re-read after each ask. Not derived from
  // `notify`: a switch that is on and a browser that says "denied" is exactly
  // the state worth telling somebody about, and one boolean cannot say it.
  const [permission, setPermission] = useState(permissionNow);
  // Why it could not be switched on, when it could not. Only ever set by the
  // attempt itself, so it says something about a thing that just happened
  // rather than nagging about a browser on the way in.
  const [why, setWhy] = useState<"" | "denied" | "needs-install" | "failed">("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const canNotify = supported() || push.supported() || push.isIOS();

  /** Turning it ON is the gesture that asks the browser. `requestPermission`
   *  needs a real click, and a prompt on first load is the one people block.
   *
   *  Push first, always: it is the only kind that arrives with the app closed,
   *  which on a phone is the only case that matters. The page's own banners are
   *  the fallback for a browser that cannot do push at all. */
  const toggleNotify = async () => {
    if (busy) return;
    setBusy(true);
    setWhy("");
    try {
      if (notify) {
        await push.disable();
        setOn(false);
        onNotify(false, false);
        return;
      }

      const result = await push.enable();
      setPermission(permissionNow());
      if (result === "on") {
        setOn(true);
        onNotify(true, true);
        return;
      }
      if (result === "denied") {
        setWhy("denied");
        return;
      }
      // No push here. On iOS in a tab that is expected and fixable — say so.
      // Everywhere else, fall back to banners the page raises, which still
      // cover a background tab on a desktop.
      if (result === "needs-install") {
        setWhy("needs-install");
        return;
      }
      const decided = await askPermission();
      setPermission(decided);
      // Left off when the browser said no: a switch that reads "on" while
      // nothing can ever appear is a lie you only find out about by missing
      // something.
      if (decided !== "granted") {
        setWhy("denied");
        return;
      }
      setOn(true);
      onNotify(true, false);
    } finally {
      setBusy(false);
    }
  };

  const on = notify && permission === "granted";
  const currentTheme = THEMES.find((theme) => theme.id === current)?.name ?? "Dark";
  const orderedProjects = [...projects].sort(compareProjectNames);

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="panel-head settings-page-head">
          <div className="panel-id">
            <div className="panel-name" id="settings-title">Settings</div>
            <div className="panel-path">OctiqFlow preferences</div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <div className="settings-nav-list">
              <SettingsNavButton
                section="projects"
                label="Projects"
                detail={`${projects.length} ${projects.length === 1 ? "project" : "projects"}`}
                active={section === "projects"}
                onPick={setSection}
              />
              {onAgentsMode && (
                <SettingsNavButton
                  section="agents"
                  label="Agents"
                  detail={agentsMode ? "Agents mode on" : "Agents mode off"}
                  active={section === "agents"}
                  onPick={setSection}
                />
              )}
              {canNotify && (
                <SettingsNavButton
                  section="notifications"
                  label="Notifications"
                  detail={on ? "On" : "Off"}
                  active={section === "notifications"}
                  onPick={setSection}
                />
              )}
              <SettingsNavButton section="memory" label="Memory Vault" detail="Shared agent knowledge" active={section === "memory"} onPick={setSection} />
              <SettingsNavButton
                section="appearance"
                label="Appearance"
                detail={currentTheme}
                active={section === "appearance"}
                onPick={setSection}
              />
            </div>
            <p className="settings-nav-foot">Switches apply automatically.</p>
          </nav>

          <main className="settings-content">
            {section === "memory" && <MemoryVaultSettings />}
            {section === "agents" && onAgentsMode && (
              <AgentsSettings on={agentsMode} onToggle={onAgentsMode} projects={orderedProjects} />
            )}
            {section === "projects" && (
              <section className="settings-section" aria-labelledby="settings-projects-title">
                <header className="settings-section-head">
                  <div>
                    <h2 id="settings-projects-title">Projects</h2>
                    <p>Manage names, folders, environment, links, and visibility.</p>
                  </div>
                  <button className="settings-primary" type="button" onClick={() => onProject("new")}>
                    <PlusIcon />
                    <span>New project</span>
                  </button>
                </header>

                {projects.length ? (
                  <div className="settings-projects">
                    {orderedProjects.map((project) => (
                      <button
                        className="settings-project"
                        type="button"
                        key={project.id}
                        onClick={() => onProject(project.id)}
                        aria-label={`Configure ${project.name}`}
                      >
                        <ProjectAvatar project={project} size="medium" />
                        <span className="settings-project-copy">
                          <span className="settings-project-name">{project.name}</span>
                          {project.primary_path && (
                            <span className="settings-project-path" title={project.primary_path}>
                              <bdi>{project.primary_path}</bdi>
                            </span>
                          )}
                        </span>
                        {project.shelved && <span className="settings-project-state">Shelved</span>}
                        <ChevronIcon />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="settings-empty">
                    <strong>No projects yet</strong>
                    <span>Create a project to give chats their own workspace.</span>
                  </div>
                )}
              </section>
            )}

            {section === "notifications" && canNotify && (
              <section className="settings-section" aria-labelledby="settings-notifications-title">
                <header className="settings-section-head">
                  <div>
                    <h2 id="settings-notifications-title">Notifications</h2>
                    <p>Choose when OctiqFlow can bring a chat back to your attention.</p>
                  </div>
                </header>

                <div className="settings-control-row">
                  <div className="settings-control-copy">
                    <h3>Chat activity</h3>
                    <p>
                      Get a banner when a chat you are not watching finishes, needs permission,
                      or asks you a question.
                    </p>
                  </div>
                  <button
                    className={`set-switch${on ? " is-on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    disabled={busy}
                    onClick={toggleNotify}
                  >
                    <span className="set-switch-track" aria-hidden="true" />
                    <span className="set-switch-text">{busy ? "…" : on ? "On" : "Off"}</span>
                  </button>
                </div>

                <p className="settings-note">
                  On a phone, alerts can arrive even while OctiqFlow is closed. Nothing appears
                  for the chat currently on screen.
                </p>

                {why === "needs-install" && (
                  <p className="set-warn">
                    iPhone and iPad only allow notifications for an app on the
                    home screen. Tap Share, then <b>Add to Home Screen</b>, open
                    OctiqFlow from there, and turn this on again.
                  </p>
                )}

                {(why === "denied" || permission === "denied") && (
                  <p className="set-warn">
                    This browser is blocking notifications for OctiqFlow. Allow
                    them in the site settings and come back.
                  </p>
                )}

                {why === "failed" && (
                  <p className="set-warn">
                    Could not register for notifications. This needs an https
                    address — a plain http one will not do, even on your own
                    network.
                  </p>
                )}
              </section>
            )}

            {section === "appearance" && (
              <section className="settings-section settings-appearance" aria-labelledby="settings-appearance-title">
                <header className="settings-section-head">
                  <div>
                    <h2 id="settings-appearance-title">Appearance</h2>
                    <p>Keep it light, stay focused in dark, or add some colour with fun mode.</p>
                  </div>
                </header>

                <div className="thm-grid" role="radiogroup" aria-label="Appearance">
                  {THEMES.map((theme) => {
                    const p = preview(theme);
                    const selected = theme.id === current;
                    return (
                      <button
                        key={theme.id}
                        className={`thm${selected ? " is-on" : ""}`}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => choose(theme.id)}
                      >
                        <span className="thm-shot" style={{ background: p.bg }} aria-hidden="true">
                          <span className="thm-bar" style={{ background: p.sunken }} />
                          <span className="thm-card" style={{ background: p.card }} />
                          <span className="thm-line" style={{ background: p.fg }} />
                          <span className="thm-dot" style={{ background: p.accent }} />
                        </span>
                        <span className="thm-name">{theme.name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </main>
        </div>
      </aside>
    </>
  );
}

function SettingsNavButton({ section, label, detail, active, onPick }: {
  section: SettingsSection;
  label: string;
  detail: string;
  active: boolean;
  onPick: (section: SettingsSection) => void;
}) {
  return (
    <button
      className={`settings-nav-item${active ? " is-on" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onPick(section)}
    >
      <SettingsIcon section={section} />
      <span className="settings-nav-copy">
        <span>{label}</span>
        <small>{detail}</small>
      </span>
    </button>
  );
}

function SettingsIcon({ section }: { section: SettingsSection }) {
  if (section === "agents") {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.4" /><path d="M16 14.2c2.9.3 5 2.6 5 5.8" /></svg>;
  }
  if (section === "memory") {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" /><path d="M12 5v15" /></svg>;
  }
  if (section === "projects") {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7.5h7l2 2h9v9.5H3z" /><path d="M3 7.5V5h7l2 2h6" /></svg>;
  }
  if (section === "notifications") {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>;
  }
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18c2.2-2.2 3.3-5.2 3.3-9S14.2 5.2 12 3Z" /><path d="M3 12h18" /></svg>;
}

function PlusIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function ChevronIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;
}
