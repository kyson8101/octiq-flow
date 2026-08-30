// The CLI's settings list, drawn as settings.
//
// `/config` is answered by the CLI itself, and its answer is thirty lines of
// `key=a|b|c` — a terminal's way of saying "here are your settings, type one
// back at me". In a chat that is a wall of grey text you then have to copy out
// by hand, one line per change, getting the spelling exactly right.
//
// So the wall is read (`lib/configUsage`) and drawn as what it always was: rows
// with the choices on them. Clicking one sends `/config key=value` — the very
// line you would have typed, into the same chat, so the CLI's own confirmation
// lands underneath it and the transcript still reads as a conversation. Nothing
// here reaches around the agent, and nothing here keeps a settings store of its
// own.
//
// ## Why it does not claim to know your current values
//
// Because it does not. The usage block lists what a key ACCEPTS and never what
// it holds, and the file the CLI keeps them in spells them differently again
// (`tips` lives as `spinnerTipsEnabled`). A row marked with a value it does not
// have is worse than a row marked with nothing — you would stop reading the
// confirmations, which are the only true answer here.
//
// What it does know is what has been SET where it can see: a `Set … to …` the
// CLI wrote in this conversation (`confirmedSetting`), including the ones sent
// from this panel a moment ago. Those rows say so. The rest simply offer.
import { createContext, useContext, useMemo } from "react";
import {
  confirmedSetting,
  groupSettings,
  parseConfigUsage,
  settingLabel,
  type Setting,
} from "../lib/configUsage";
import { RollingText } from "./RollingNumber";
import "./ConfigPanel.css";

type ConfigWorld = {
  /** Send a line to the agent, as though it had been typed. */
  say: (line: string) => void;
  /** The last few things the CLI said in this chat. The confirmations are among
   *  them — `Set Verbose output to true` — and they are the only true word on
   *  what a setting holds, so the panel reads them rather than guessing. */
  said: string[];
};

const ConfigContext = createContext<ConfigWorld>({ say: () => {}, said: [] });

/** Wraps the transcript so a panel deep inside it can send a line and can see
 *  what the chat has been told. Both come from above — the panel is a block in
 *  a message, and a block has no way to reach the chat it is in. */
export function ConfigWorldProvider({
  say,
  said,
  children,
}: ConfigWorld & { children: React.ReactNode }) {
  const world = useMemo(() => ({ say, said }), [say, said]);
  return <ConfigContext.Provider value={world}>{children}</ConfigContext.Provider>;
}

/** Whether this text is the CLI's settings list. Kept here so the transcript
 *  has one thing to ask rather than two. */
export function isConfigUsage(text: string): boolean {
  return parseConfigUsage(text) !== null;
}

export function ConfigPanel({ text }: { text: string }) {
  const settings = useMemo(() => parseConfigUsage(text), [text]);
  const groups = useMemo(() => (settings ? groupSettings(settings) : []), [settings]);
  const { say, said } = useContext(ConfigContext);
  // Matched against THIS panel's keys, not against a list gathered elsewhere:
  // an older `/config` may have offered keys this build of the CLI no longer
  // has, and each panel should answer for the list it is showing.
  const known = useMemo(() => {
    const out = new Map<string, string>();
    const keys = settings?.map((s) => s.key) ?? [];
    if (!keys.length) return out;
    // Latest wins — the same setting can be changed twice in one conversation.
    for (const line of said) {
      const set = confirmedSetting(line, keys);
      if (set) out.set(set.key, set.value);
    }
    return out;
  }, [said, settings]);
  if (!settings) return null;

  return (
    <div className="cfg">
      <div className="cfg-head">
        <span className="cfg-title">Settings</span>
        <span className="cfg-note">
          <RollingText>{`${settings.length} this agent takes · picking a value sends it`}</RollingText>
        </span>
      </div>
      {groups.map((group) => (
        <section className="cfg-group" key={group.title}>
          <h4 className="cfg-group-head">{group.title}</h4>
          {group.rows.map((row) => (
            <Row key={row.key} row={row} value={known.get(row.key)} onPick={say} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Row({
  row,
  value,
  onPick,
}: {
  row: Setting;
  value?: string;
  onPick: (line: string) => void;
}) {
  return (
    <div className="cfg-row">
      <span className="cfg-key">
        {settingLabel(row.key)}
        {/* The key itself, because it is what you type and what the CLI's own
            docs call it — the friendly name is for reading, not for using. */}
        <code className="cfg-code">{row.key}</code>
      </span>
      {row.options.length ? (
        <span className="cfg-opts">
          {row.options.map((option) => (
            <button
              type="button"
              key={option}
              className={`cfg-opt ${value === option ? "is-on" : ""}`}
              aria-pressed={value === option}
              title={`/config ${row.key}=${option}`}
              onClick={() => onPick(`/config ${row.key}=${option}`)}
            >
              {option}
            </button>
          ))}
        </span>
      ) : (
        // `<value>`: anything goes, so there is nothing to offer. It says what
        // to type instead of pretending to be a control.
        <span className="cfg-free">
          <code className="cfg-code">/config {row.key}=…</code>
        </span>
      )}
    </div>
  );
}
