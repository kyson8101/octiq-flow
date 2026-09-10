/** Development-only visual review: open /mascots.html on the Vite server. */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Mascot } from "./components/Mascot";
import type { MascotMood } from "./components/Mascot";
import { MODELS } from "./lib/agentProviders";
import "./mascots-preview.css";

function RobotStudio() {
  const [mood, setMood] = useState<MascotMood>("idle");
  const [asleep, setAsleep] = useState(false);
  const [alert, setAlert] = useState(false);
  const [light, setLight] = useState(false);
  const [shown, setShown] = useState(true);
  return (
    <main className={light ? "studio light" : "studio"}>
      <header><span className="wordmark">octiqflow <span>/ avatar studio</span></span><button onClick={() => setLight(!light)}>{light ? "Dark surface" : "Light surface"}</button></header>
      <section className="intro"><p className="eyebrow">MEET YOUR LITTLE CREW</p><h1>Familiar faces.<br /><span>Every state.</span></h1><p>Your models, at a glance.<br />Expressions that follow the conversation.</p></section>
      <nav aria-label="Expression state">
        {([ ["idle", "Smile"], ["think", "Think"], ["work", "Work"], ["still", "Neutral"] ] as const).map(([value, label]) => <button key={value} aria-pressed={mood === value && !asleep} onClick={() => { setMood(value); setAsleep(false); }}>{label}</button>)}
        <button aria-pressed={asleep} onClick={() => setAsleep(!asleep)}>Sleep</button>
        <label><input type="checkbox" checked={alert} onChange={e => setAlert(e.target.checked)} /> Background task</label>
      </nav>
      <section className="crew" aria-label="Robot cast">
        {shown && MODELS.map(m => <article key={m.id}>
          <div className="model-label"><span>{m.agent === "pi" ? "PI / CODEX" : m.agent.toUpperCase()}</span><span className="state">{asleep ? "RESTING" : mood === "idle" ? "OFF DUTY" : mood === "work" ? "AT WORK" : mood === "think" ? "THINKING" : "ON DISPLAY"}</span></div>
          <div className="stage"><Mascot robot={m.composerStyle} size={170} mood={mood} asleep={asleep} alert={alert} /></div>
          <h2>{m.model === "Default" ? m.name : m.model}</h2><p>{m.hint}</p>
          <div className="sizes"><span><Mascot robot={m.composerStyle} size={28} mood={mood} asleep={asleep} alert={alert} />Chat · 28</span><span><Mascot robot={m.composerStyle} size={44} mood={mood} asleep={asleep} alert={alert} />Picker · 44</span></div>
        </article>)}
      </section>
      <footer><span>MODEL AVATARS · LIVE EXPRESSIONS</span><button onClick={() => setShown(!shown)}>{shown ? "Unmount crew" : "Mount crew"}</button></footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><RobotStudio /></StrictMode>);
