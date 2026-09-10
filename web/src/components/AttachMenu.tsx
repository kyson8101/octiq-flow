/** The composer offers server file references and native browser uploads. */
export function AttachList({
  onReference,
  onUpload,
}: {
  /** Point at a file on the machine running the agents. */
  onReference: () => void;
  /** Upload files from this device using the native browser picker. */
  onUpload: () => void;
}) {
  return (
    <>
      <button type="button" role="menuitem" className="picker-item" onClick={onReference}>
        <span className="picker-name">Reference a file</span>
        <span className="picker-model">on the machine running the agents</span>
      </button>
      <button type="button" role="menuitem" className="picker-item" onClick={onUpload}>
        <span className="picker-name">Upload a file</span>
        <span className="picker-model">from this device — up to 12 MB per file</span>
      </button>
    </>
  );
}
