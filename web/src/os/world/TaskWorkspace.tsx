import { useEffect, useRef, useState } from "react";
import { Transcript } from "./Transcript";
import { label, type Mutate, type Task, type World } from "./types";

export function TaskWorkspace({ task, world, mutate, busy, back, backLabel }: {
  task: Task;
  world: World;
  mutate: Mutate;
  busy: boolean;
  back?: () => void;
  backLabel?: string;
}) {
  const [message, setMessage] = useState("");
  const [evidence, setEvidence] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [errorPanel, setErrorPanel] = useState("conversation");
  const [panel, setPanel] = useState("conversation");
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const submitting = useRef(false);
  const closed = ["done", "cancelled"].includes(task.status);
  const disabled = busy || pending;
  const currentAgent = world.agents.find((agent) => agent.id === task.agentId);
  const project = world.projects.find((item) => item.id === task.projectId);
  const workflow = world.workflows.find((item) => item.id === task.workflowId);

  useEffect(() => {
    if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [task.messages.length, task.messages.at(-1)?.body, task.status, panel]);

  const control = (action: "redirect" | "pause" | "resume" | "cancel") => {
    if (submitting.current || disabled || closed || (action === "redirect" && !message.trim())) return;
    submitting.current = true;
    setPending(true);
    setError("");
    setErrorPanel("conversation");
    follow.current = true;
    const submitted = message;
    void mutate("task_direction", {
      taskId: task.id,
      control: action,
      body: message.trim() || `Founder requested ${action}.`,
    }).then(() => setMessage((value) => value === submitted ? "" : value))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { submitting.current = false; setPending(false); });
  };
  const reply = () => {
    follow.current = true;
    setPanel("conversation");
    requestAnimationFrame(() => {
      if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      composer.current?.focus();
    });
  };

  return (
    <div className="ow-task-session">
      {back && <button type="button" className="ow-task-back" onClick={back}>← {backLabel ?? "Back to tasks"}</button>}
      <div className="ow-secretary-desk ow-task-workspace" data-panel={panel}>
        <nav className="ow-secretary-panel-switch" aria-label="Task panels">
          <button type="button" aria-pressed={panel === "conversation"} onClick={() => setPanel("conversation")}>Conversation</button>
          <button type="button" aria-pressed={panel === "blueprint"} onClick={() => setPanel("blueprint")}>Plan</button>
        </nav>
        <section className="ow-secretary-conversation" aria-label="Task conversation">
          <header className="ow-secretary-pane-header">
            <div><span className="ow-eyebrow">{project?.name ?? "TASK"}</span><h3>Conversation</h3></div>
            <span className="ow-muted">{currentAgent ? `With ${currentAgent.name}` : task.route === "auto" ? "Awaiting assignment" : "Unassigned"}</span>
          </header>
          <div className="ow-secretary-transcript" ref={transcript} role="log" aria-label="Task messages" aria-live="polite"
            onScroll={(event) => {
              const el = event.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}>
            <article className="ow-secretary-message ow-secretary-message-user">
              <span className="ow-eyebrow">YOUR TASK</span>
              <p>{task.title}</p>
              {task.detail && <p>{task.detail}</p>}
            </article>
            {!!task.messages.length && <Transcript messages={task.messages} world={world} />}
            {["working", "planning", "queued"].includes(task.status) && <p className="ow-muted" role="status">{task.status === "queued" ? "Waiting for the next response…" : task.status === "planning" ? "Preparing the task plan…" : "Working on this task…"}</p>}
          </div>
          <form className="ow-secretary-composer" onSubmit={(event) => { event.preventDefault(); control("redirect"); }}>
            {error && errorPanel === "conversation" && <p className="ow-blueprint-error" role="alert">{error}</p>}
            {closed ? <p className="ow-muted">{task.status === "done" ? "Task completed." : "Task cancelled."} The conversation and plan remain available here.</p> : <>
              <label className="ow-field"><span>Message about this task</span>
                <textarea ref={composer} value={message} onChange={(event) => setMessage(event.target.value)} rows={3} maxLength={8000}
                  placeholder={task.status === "needs_input" ? "Answer the agent’s question…" : "Add context, ask a question, or change direction…"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                      event.preventDefault(); control("redirect");
                    }
                  }} />
              </label>
              <div className="ow-secretary-actions">
                <span className="ow-muted">Enter to send · Shift+Enter for a new line</span>
                <button type="submit" className="ow-primary" disabled={disabled || !message.trim()}>{pending ? "Sending…" : "Send"}</button>
              </div>
              <details className="ow-task-controls"><summary>Task controls</summary>
                <div className="ow-actions">
                  <button type="button" disabled={disabled || task.status === "paused"} onClick={() => control("pause")}>Pause</button>
                  {["paused", "needs_input"].includes(task.status) && <button type="button" disabled={disabled} onClick={() => control("resume")}>Resume</button>}
                  <button type="button" className="ow-danger" disabled={disabled} onClick={() => control("cancel")}>Cancel task</button>
                </div>
                <p className="ow-muted">Stopping leaves completed file changes recorded.</p>
              </details>
              <p className="ow-task-composer-note">Sending a message updates this task’s direction and continues work.</p>
            </>}
          </form>
        </section>
        <section className="ow-secretary-plan" aria-label="Task plan">
          <header className="ow-secretary-pane-header">
            <div><span className="ow-eyebrow">{task.route === "auto" ? "AUTO PM" : "DIRECT ASSIGNMENT"}</span><h3>Plan</h3></div>
            <span className={`ow-status ${task.status}`} role="status">{label(task.status)}</span>
          </header>
          <div className="ow-secretary-plan-scroll">
            <h4>Objective</h4>
            <p className="ow-prose">{task.detail || task.title}</p>
            {workflow && <p className="ow-muted">Workflow · {workflow.name}</p>}
            {task.steps.length ? <>
              <p className="ow-muted">{Math.min(task.step, task.steps.length)} / {task.steps.length} steps complete</p>
              <ol className="ow-task-plan-steps">
                {task.steps.map((step, index) => {
                  const complete = index < task.step;
                  const current = index === task.step;
                  return <li key={index} className={current ? "current" : ""} aria-current={current ? "step" : undefined}>
                    <header><strong>{world.professions.find((item) => item.id === step.professionId)?.name ?? "Step"}</strong>
                      <span className="ow-tag">{complete ? "Complete" : current ? closed ? "Stopped" : "Current" : "Upcoming"}</span></header>
                    <p className="ow-prose">{step.instruction}</p>
                    {step.agentId && <small className="ow-muted">{world.agents.find((agent) => agent.id === step.agentId)?.name ?? "Agent"}</small>}
                    {step.evidence && <details><summary>Step evidence</summary><p className="ow-prose">{step.evidence}</p></details>}
                  </li>;
                })}
              </ol>
            </> : task.route === "direct" ? <div className="ow-note"><strong>Direct task</strong><p>{currentAgent?.name ?? "The assigned agent"} works from the objective above. Progress and questions appear in the conversation.</p></div>
              : <div className="ow-note"><strong>No execution plan yet</strong><p>The PM’s steps will appear here when prepared.</p>
                  {workflow && <p>{workflow.professionIds.map((id) => world.professions.find((item) => item.id === id)?.name ?? "Step").join(" → ")}</p>}
                </div>}
            {task.evidence && <div className="ow-note"><strong>{task.status === "done" ? "Verified outcome" : "Outcome evidence"}</strong><p className="ow-prose">{task.evidence}</p></div>}
          </div>
          <div className="ow-secretary-confirm">
            {error && errorPanel === "blueprint" && <p className="ow-blueprint-error" role="alert">{error}</p>}
            {task.status === "verifying" ? <form className="ow-task-verify" onSubmit={(event) => {
              event.preventDefault();
              if (submitting.current || disabled || !evidence.trim()) return;
              submitting.current = true; setPending(true); setError(""); setErrorPanel("blueprint");
              void mutate("verify_task", { taskId: task.id, evidence: evidence.trim() })
                .then(() => setEvidence(""))
                .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
                .finally(() => { submitting.current = false; setPending(false); });
            }}>
              <label className="ow-field"><span>Verification evidence</span><textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} maxLength={8000} rows={2} required placeholder="Checks performed and their results" /></label>
              <button type="submit" className="ow-primary" disabled={disabled || !evidence.trim()}>Verify and complete</button>
            </form> : <>
              <p>{closed ? "This task is closed." : task.status === "needs_input" ? "The agent has a question. Reply in the conversation." : "The plan follows this task’s progress."}</p>
              {!closed && <button type="button" onClick={reply}>Reply in conversation</button>}
            </>}
          </div>
        </section>
      </div>
    </div>
  );
}
