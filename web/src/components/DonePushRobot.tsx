import "./DonePush.css";

/** The little robot that pushes a done chat's row out of the Active list
 *  (`lib/donePush`). Facing right, its hands on the row's left edge. Drawn in
 *  the quiet ink tokens only: the accent means a turn in flight, and this is
 *  not one. It is decoration: hidden from assistive tech and never a target. */
export function DonePushRobot() {
  return (
    <span className="done-push-lane" aria-hidden="true">
      <svg className="done-push-robot" viewBox="0 0 28 26" width="35" height="33" fill="none"
        strokeLinecap="round" strokeLinejoin="round">
        <path className="done-push-antenna" d="M12 4.5V2.2" />
        <circle className="done-push-bulb" cx="12" cy="1.6" r="1.1" />
        <rect className="done-push-body" x="4" y="5" width="16" height="12" rx="3.5" />
        <circle className="done-push-eye" cx="14" cy="10.5" r="1.3" />
        <circle className="done-push-eye" cx="18" cy="10.5" r="1.3" />
        <path className="done-push-arm" d="M20 13h5.5" />
        <g className="done-push-leg done-push-leg-a"><path d="M9 17v4.5h-2.5" /></g>
        <g className="done-push-leg done-push-leg-b"><path d="M15 17v4.5h-2.5" /></g>
      </svg>
    </span>
  );
}
