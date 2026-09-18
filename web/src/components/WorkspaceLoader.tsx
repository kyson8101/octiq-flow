import "./WorkspaceLoader.css";

const rails = ["cyan", "blue", "amber"] as const;

/** The first paint while Vite fetches the selected workspace portal. */
export function WorkspaceLoader() {
  return (
    <div
      className="workspace-loader"
      role="status"
      aria-live="polite"
      aria-label="Opening your workspace"
    >
      <div className="workspace-loader-frame">
        <header className="workspace-loader-bar" aria-hidden="true">
          <span className="workspace-loader-brand">
            <img src="/icon-512.png" alt="" draggable="false" />
            <span>OctiqFlow</span>
          </span>
          <span className="workspace-loader-state">
            <span className="workspace-loader-live" />
            Starting
          </span>
        </header>

        <div className="workspace-loader-workbench" aria-hidden="true">
          <aside className="workspace-loader-rail">
            <span className="workspace-loader-rail-title" />
            {rails.map((tone, index) => (
              <span className="workspace-loader-project" key={tone}>
                <span className={`workspace-loader-project-dot is-${tone}`} />
                <span style={{ width: `${58 - index * 8}%` }} />
              </span>
            ))}
          </aside>

          <div className="workspace-loader-thread">
            <span className="workspace-loader-thread-heading" />
            <span className="workspace-loader-thread-copy is-short" />
            <span className="workspace-loader-thread-copy" />
            <span className="workspace-loader-thread-copy is-medium" />
            <span className="workspace-loader-composer" />
          </div>

          <aside className="workspace-loader-context">
            <span className="workspace-loader-context-heading" />
            <span />
            <span />
            <span className="is-short" />
          </aside>
        </div>

        <div className="workspace-loader-focus">
          <div className="workspace-loader-mark" aria-hidden="true">
            <span className="workspace-loader-orbit" />
            <img src="/icon-512.png" alt="" draggable="false" />
          </div>
          <h1>Opening your workspace</h1>
          <p>Bringing your projects and conversations back into view.</p>
          <span className="workspace-loader-progress" aria-hidden="true">
            {rails.map((tone) => (
              <span className={`is-${tone}`} key={tone} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
