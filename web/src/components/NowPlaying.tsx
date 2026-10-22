// The one floating player: a chat's video or recording that went on playing
// when the person went to another chat (`lib/nowPlaying`). Mounted once, by
// `App`, outside every transcript, so it is there whichever chat is open.
//
// Its stage is always on the page, out of sight unless something floats: the
// element lives there while the browser's picture-in-picture window shows it,
// with a visible fallback after that window closes.
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { nowPlaying } from "../lib/nowPlaying";
import "./NowPlaying.css";

export function NowPlaying({ onBack, chatTitle }: {
  /** Open this chat and put it on screen. */
  onBack: (chat: string) => void;
  /** The chat's title, for the way back. */
  chatTitle: (chat: string) => string | null;
}) {
  const stage = useRef<HTMLSpanElement>(null);
  const view = useSyncExternalStore(nowPlaying.subscribe, nowPlaying.snapshot, () => null);
  const back = useRef(onBack);
  back.current = onBack;
  useLayoutEffect(() => {
    nowPlaying.setHost(stage.current);
    nowPlaying.setBack((chat) => back.current(chat));
    return () => { nowPlaying.setHost(null); nowPlaying.setBack(null); };
  }, []);
  const shown = view?.mode === "mini";
  const title = view?.source.chat ? chatTitle(view.source.chat) : null;
  const playing = !!view && !view.paused;
  return (
    <div
      className={`now-playing is-${view?.source.kind ?? "none"}`}
      data-shown={shown ? "true" : "false"}
      role={shown ? "region" : undefined}
      aria-label={shown ? "Now playing" : undefined}
      aria-hidden={shown ? undefined : true}
      // Out of sight is out of reach: no control is focusable while hidden.
      inert={shown ? undefined : true}
    >
      <span className="now-playing-stage" ref={stage} />
      {view && (
        <div className="now-playing-bar">
          <button type="button" className="now-playing-btn" onClick={() => nowPlaying.toggle()}
            disabled={!!view.error} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button type="button" className="now-playing-back" onClick={() => nowPlaying.goBack()}
            title={title ? `Back to ${title}` : "Back to its chat"}>
            <span className="now-playing-name" role={view.error ? "alert" : undefined}>{view.error ? "Could not load this media." : view.source.name}</span>
            <span className="now-playing-chat">{title ? `Back to ${title}` : "Back to its chat"}</span>
          </button>
          {view.canPip && (
            <button type="button" className="now-playing-btn" onClick={() => nowPlaying.pip()}
              aria-label="Picture in picture" title="Picture in picture">
              <PipIcon />
            </button>
          )}
          <button type="button" className="now-playing-btn" onClick={() => nowPlaying.close()}
            aria-label="Stop and close" title="Stop and close">
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}

const icon = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function PlayIcon() {
  return <svg {...icon}><path d="M5 3.5v9l7-4.5z" fill="currentColor" /></svg>;
}

function PauseIcon() {
  return <svg {...icon}><path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth={2} /></svg>;
}

function PipIcon() {
  return <svg {...icon}><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><rect x="8" y="8" width="5" height="3.5" rx=".5" fill="currentColor" stroke="none" /></svg>;
}

function CloseIcon() {
  return <svg {...icon}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
}
