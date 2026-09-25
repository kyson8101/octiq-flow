// The avatar half of hiring or editing an agent: see it, upload one, or have
// ChatGPT draw one (through the person's own Codex sign-in), regenerate it,
// and accept it. Nothing here saves: the form's Save does, like every other
// field, so a picture that was only previewed never becomes the agent's.
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import {
  genReducer, waitLabel, type AvatarJob, type GenState, type GenerationStatus,
} from "../lib/avatarGeneration";
import { AVATAR_TYPES, toAvatar, uploadProblem } from "../lib/avatarImage";
import { AgentAvatar } from "./AgentAvatar";

const POLL_MS = 4000;

export function AgentAvatarEditor({ name, role, avatar, agentId, onChange }: {
  name: string;
  role: string;
  /** The avatar the draft holds now; "" or absent draws initials. */
  avatar?: string;
  agentId?: string;
  /** A new data URL, or "" to remove the avatar. */
  onChange: (avatar: string) => void;
}) {
  const [gen, dispatch] = useReducer(genReducer, { kind: "checking" } as GenState);
  const [description, setDescription] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  const running = gen.kind === "running" ? gen.jobId : null;
  const runningRef = useRef<string | null>(null);
  runningRef.current = running;

  useEffect(() => {
    let alive = true;
    bridge.invoke<GenerationStatus>("agent_avatar_status", {})
      .then((status) => { if (alive) dispatch({ type: "status", status }); })
      .catch((error: unknown) => { if (alive) dispatch({ type: "statusFailed", error: String((error as Error).message ?? error) }); });
    return () => { alive = false; };
  }, []);

  // A job that finishes arrives by broadcast; its picture is fetched by id
  // and shrunk here, so what is previewed is exactly what would be saved.
  const settle = async (job: AvatarJob) => {
    if (job.state !== "done") {
      dispatch({ type: "job", job });
      return;
    }
    try {
      const full = job.image ? job : await bridge.invoke<AvatarJob>("agent_avatar_job", { id: job.id });
      if (!full.image) throw new Error("The generated picture was not returned.");
      const image = await toAvatar(full.image);
      if (runningRef.current === job.id) dispatch({ type: "job", job: { ...full, image } });
    } catch (error) {
      dispatch({ type: "job", job: { ...job, state: "failed", error: String((error as Error).message ?? error) } });
    }
  };

  useEffect(() => {
    if (!running) return;
    const off = bridge.on<AvatarJob>("agent-avatar-job", (job) => {
      if (job?.id === running && job.state !== "running") void settle(job);
    });
    // The broadcast can be missed across a reconnect; a slow poll backs it up.
    const poll = setInterval(() => {
      setNow(Date.now());
      bridge.invoke<AvatarJob>("agent_avatar_job", { id: running })
        .then((job) => { if (job.state !== "running") void settle(job); })
        .catch(() => undefined);
    }, POLL_MS);
    return () => { off(); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Leaving the form mid-generation stops the job rather than leaving it to
  // spend the person's Codex usage on a picture nobody will see.
  useEffect(() => () => {
    if (runningRef.current) void bridge.invoke("agent_avatar_cancel", { id: runningRef.current }).catch(() => undefined);
  }, []);

  const generate = async () => {
    dispatch({ type: "start" });
    try {
      const job = await bridge.invoke<AvatarJob>("agent_avatar_generate", {
        request: { name, role, description },
      });
      setNow(Date.now());
      dispatch({ type: "started", job });
    } catch (error) {
      dispatch({ type: "startFailed", error: String((error as Error).message ?? error) });
    }
  };

  const cancel = () => {
    if (running) void bridge.invoke("agent_avatar_cancel", { id: running }).catch(() => undefined);
    dispatch({ type: "cancel" });
  };

  const upload = async (file: File | undefined) => {
    setUploadError("");
    if (!file) return;
    const problem = uploadProblem(file);
    if (problem) {
      setUploadError(problem);
      return;
    }
    try {
      onChange(await toAvatar(file));
    } catch (error) {
      setUploadError(String((error as Error).message ?? error));
    }
  };

  return (
    <AgentAvatarEditorView
      name={name}
      avatar={avatar}
      agentId={agentId}
      gen={gen}
      now={now}
      description={description}
      uploadError={uploadError}
      onDescription={setDescription}
      onUpload={() => fileRef.current?.click()}
      onRemove={() => onChange("")}
      onGenerate={() => void generate()}
      onCancel={cancel}
      onAccept={() => {
        if (gen.kind === "candidate") onChange(gen.image);
        dispatch({ type: "accept" });
      }}
      onDiscard={() => dispatch({ type: "discard" })}
      fileInput={(
        <input
          ref={fileRef}
          className="avatar-editor-file"
          type="file"
          accept={AVATAR_TYPES.join(",")}
          aria-label="Upload an avatar image"
          onChange={(event) => {
            void upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      )}
    />
  );
}

/** Pure view, so each state renders in a test without a backend. */
export function AgentAvatarEditorView({
  name, avatar, agentId, gen, now, description, uploadError,
  onDescription, onUpload, onRemove, onGenerate, onCancel, onAccept, onDiscard, fileInput,
}: {
  name: string;
  avatar?: string;
  agentId?: string;
  gen: GenState;
  now: number;
  description: string;
  uploadError: string;
  onDescription: (text: string) => void;
  onUpload: () => void;
  onRemove: () => void;
  onGenerate: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onDiscard: () => void;
  fileInput?: ReactNode;
}) {
  const shownName = name.trim() || "New agent";
  const busy = gen.kind === "starting" || gen.kind === "running";
  const canGenerate = gen.kind === "idle" || gen.kind === "failed" || gen.kind === "candidate";
  return (
    <fieldset className="avatar-editor team-form-wide">
      <legend>Avatar</legend>
      <div className="avatar-editor-row">
        <div className="avatar-editor-now">
          <AgentAvatar name={shownName} avatar={avatar || undefined} id={agentId ?? shownName} size={56} />
          <span className="avatar-editor-caption">{avatar ? "Current" : "Initials"}</span>
        </div>

        {gen.kind === "candidate" && (
          <div className="avatar-editor-now is-candidate" aria-live="polite">
            <AgentAvatar name={`${shownName}, generated`} avatar={gen.image} id={agentId ?? shownName} size={56} />
            <span className="avatar-editor-caption">Generated</span>
          </div>
        )}

        <div className="avatar-editor-actions">
          <div className="avatar-editor-buttons">
            {gen.kind === "candidate" ? (
              <>
                <button className="settings-primary" type="button" onClick={onAccept}>Use this</button>
                <button className="vault-button" type="button" onClick={onGenerate}>Regenerate</button>
                <button className="vault-button" type="button" onClick={onDiscard}>Discard</button>
              </>
            ) : busy ? (
              <button className="vault-button" type="button" onClick={onCancel}>Cancel</button>
            ) : (
              <>
                <button className="vault-button" type="button" onClick={onUpload}>Upload image</button>
                <button
                  className="vault-button"
                  type="button"
                  onClick={onGenerate}
                  disabled={!canGenerate || !name.trim()}
                  title={!name.trim() ? "Give the agent a name first" : "Uses your Codex sign-in with ChatGPT, and counts toward its usage"}
                >
                  Generate with ChatGPT
                </button>
                {avatar && <button className="vault-button" type="button" onClick={onRemove}>Remove</button>}
              </>
            )}
          </div>
          {fileInput}

          {(gen.kind === "idle" || gen.kind === "failed") && (
            <input
              className="avatar-editor-description"
              value={description}
              maxLength={500}
              placeholder="Optional look, e.g. round glasses, calm, teal background"
              aria-label="Describe the avatar (optional)"
              onChange={(event) => onDescription(event.target.value)}
            />
          )}

          <p className="avatar-editor-status" role="status" aria-live="polite">
            {gen.kind === "checking" && "Checking whether ChatGPT can draw one here…"}
            {gen.kind === "starting" && "Starting…"}
            {gen.kind === "running" && waitLabel(gen.startedAt, now)}
            {gen.kind === "candidate" && "Use it, or regenerate. Nothing is saved until you press Save."}
            {gen.kind === "failed" && <span className="avatar-editor-error">{gen.error}</span>}
            {gen.kind === "unavailable" && (
              <span>
                {gen.reason}
                {gen.setup && <> {gen.setup}</>}
                {" "}You can still upload an image.
              </span>
            )}
            {uploadError && <span className="avatar-editor-error"> {uploadError}</span>}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
