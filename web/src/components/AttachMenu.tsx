/** The rows behind the composer's "+".
 *
 *  These were two icon buttons sitting in the toolbar, a clip and a picture,
 *  and side by side they read as one idea drawn twice. They are not: the clip
 *  POINTS at a file that already lives on the machine running the agents, so a
 *  whole file never travels through the prompt, while the picture UPLOADS
 *  bytes off the device in your hand, which is the only way a photo gets off a
 *  phone. That difference is worth a sentence each, and a sentence needs a
 *  menu — so one "+" opens them, named, instead of two icons guessing at it.
 *
 *  It lives in its own file rather than beside the composer's other lists
 *  because the composer imports the bridge at module load, and the bridge
 *  reads `location` — a test that pulls in the composer to check two rows
 *  never gets as far as the rows. */
export function AttachList({
  onReference,
  onUpload,
}: {
  /** Point at a file on the machine running the agents. */
  onReference: () => void;
  /** Send an image up from this device. */
  onUpload: () => void;
}) {
  return (
    <>
      <button type="button" role="menuitem" className="picker-item" onClick={onReference}>
        <span className="picker-name">Reference a file</span>
        <span className="picker-model">on the machine running the agents</span>
      </button>
      <button type="button" role="menuitem" className="picker-item" onClick={onUpload}>
        <span className="picker-name">Upload an image</span>
        <span className="picker-model">a picture from this device — pasting works too</span>
      </button>
    </>
  );
}
