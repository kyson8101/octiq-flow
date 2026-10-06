// The mission's place between Draft and Closed, as one quiet row of steps.
//
// The step it is on carries its name; the rest are marks with their names in a
// tooltip and to a screen reader, so the row says one thing at a glance. The
// detail — which branch, merged by what — is behind the panel's settings, not
// here. See lib/mission for where each step comes from.
import { MISSION_STAGES, stageLabel, type MissionState } from "../lib/mission";

export function MissionTrack({ state, live }: { state: MissionState; live: boolean }) {
  const at = MISSION_STAGES.findIndex((item) => item.key === state.stage);
  const label = stageLabel(state);
  return (
    <ol className="mission-track" aria-label={`Mission: ${label}${state.blocked ? ", waiting on someone" : ""}`}
      data-blocked={state.blocked || undefined} data-abandoned={state.abandoned || undefined}>
      {MISSION_STAGES.map((item, i) => {
        const here = i === at;
        return (
          <li key={item.key} className={here ? "is-current" : i < at ? "is-done" : undefined}
            aria-current={here ? "step" : undefined} title={here ? undefined : item.label}
            data-live={here && live ? true : undefined}>
            <span className="mission-step-mark" aria-hidden="true" />
            {here ? <span className="mission-step-label">{label}{state.blocked && <small> · waiting</small>}</span>
              : <span className="sr-only">{item.label}</span>}
          </li>
        );
      })}
    </ol>
  );
}
