// What keeps a chat's video or recording playing when the person goes to
// another chat.
//
// A player in a reply dies with the transcript: switching chats unmounts it,
// and a page drawn in the chat's place (`App`'s `chatShown`) hides it while it
// goes on playing where nobody can see or stop it. So the player's element is
// not React's. It is made by hand, kept here, and put into whichever holder
// should show it: the reply's own slot while its chat is on screen, the one
// floating host otherwise. A move is one `appendChild`, inside one task, which
// the browser does not pause for (the media element's removal steps wait for a
// stable state and find it in a document again), and a native picture-in-
// picture window stays open across it. Seeking a second element instead would
// rebuffer, which is a gap you can hear, and would need two copies of the file.
//
// Rules:
//   - At most one element is detached at a time. Starting any other player, or
//     another one leaving, drops it (paused, its source released).
//   - Only a PLAYING element leaves its chat (or one in picture-in-picture).
//     A paused one stays in its slot, or is released with it once the commit
//     that unmounted it is over (a slot for the same file mounted in that
//     commit takes it back instead).
//   - A video that leaves asks for the browser's picture-in-picture, while the
//     press that changed chats still counts as the person's. Refused, or not
//     offered, it is the in-page mini-player.
//   - Its chat back on screen, the element goes back into the first slot of
//     that chat that names the same file, still playing. With no such slot it
//     stays where it is: the position is never lost.
//   - The browser's own window: closed (the video is paused) parks the element
//     out of sight, kept for its chat; "back to tab" (still playing) asks the
//     page to open its chat.
//
// The store only needs what `MediaLike`, `Holder` and `Env` name, so the
// tests drive it with plain objects in the node environment.

export type MediaKind = "video" | "audio";

/** What a player plays, and whose it is. `chat` is the conversation id the
 *  transcript belongs to; null for a player outside a chat (the file dock),
 *  which never floats. */
export type MediaSource = {
  chat: string | null;
  path: string;
  kind: MediaKind;
  name: string;
};

/** What the store needs of an HTMLMediaElement. */
export interface MediaLike {
  paused: boolean;
  ended: boolean;
  controls: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  remove(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  requestPictureInPicture?: () => Promise<unknown>;
}

/** Where an element can be shown: a slot in a reply, or the floating host. */
export interface Holder {
  appendChild(node: never): unknown;
}

export interface Env {
  /** The element in the browser's picture-in-picture window, if any. */
  pipElement(): unknown;
  /** `document.pictureInPictureEnabled`. */
  pipEnabled(): boolean;
  exitPip(): Promise<void>;
  later(fn: () => void, ms: number): void;
  /** After the commit in progress (a microtask). */
  soon(fn: () => void): void;
}

/** How the detached element is being shown.
 *  - `mini`: the in-page mini-player
 *  - `asking`: picture-in-picture asked for, not answered yet (nothing drawn)
 *  - `pip`: in the browser's own window
 *  - `parked`: that window was closed; paused, out of sight, kept for its chat */
export type FloatMode = "mini" | "asking" | "pip" | "parked";

export type NowPlayingView = {
  source: MediaSource;
  mode: FloatMode;
  paused: boolean;
  /** Whether a picture-in-picture button can be offered. */
  canPip: boolean;
};

type Slot = {
  holder: Holder;
  source: MediaSource;
  create: () => MediaLike;
  bind: (el: MediaLike) => () => void;
  el: MediaLike | null;
  unbind: (() => void) | null;
};

type Detached = {
  el: MediaLike;
  source: MediaSource;
  mode: FloatMode;
  /** Floated while its chat was still on screen: a slot unmounts before the
   *  page says the chat has gone, in the same commit. Picture-in-picture is
   *  asked for when it says so, or not at all if the chat stays. */
  pipOnLeave?: boolean;
};

/** How long picture-in-picture may take to answer before the mini-player is
 *  drawn anyway. */
export const PIP_ANSWER_MS = 1500;

const sameFile = (a: MediaSource, b: MediaSource) => a.chat === b.chat && a.path === b.path && a.kind === b.kind;

export class NowPlaying {
  private slots: Slot[] = [];
  /** Elements whose slot unmounted and that do not float, kept until the
   *  commit is over: opening a chat remounts its rows once, and the new slot
   *  for the same file takes its element back where it was. */
  private orphans: Array<{ el: MediaLike; source: MediaSource }> = [];
  private detached: Detached | null = null;
  private shown = new Set<string>();
  private host: Holder | null = null;
  private lastPlayed: MediaLike | null = null;
  private known = new WeakSet<MediaLike>();
  /** Elements whose picture-in-picture window the page itself closed. */
  private closing = new WeakSet<MediaLike>();
  private back: ((chat: string) => void) | null = null;
  private listeners = new Set<() => void>();
  private view: NowPlayingView | null = null;

  constructor(private env: Env) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = (): NowPlayingView | null => this.view;

  /** Whether the detached element is this chat's file: its slot should draw
   *  it at once, near the screen or not, rather than wait. */
  holds(chat: string | null, path: string): boolean {
    const held = this.detached;
    return !!held && chat !== null && held.source.chat === chat && held.source.path === path;
  }

  /** The floating host's own holder. Mounted once, by `App`. */
  setHost(holder: Holder | null) { this.host = holder; }

  /** What "back to its chat" does: the page opens that chat. */
  setBack(back: ((chat: string) => void) | null) { this.back = back; }

  /** A reply's player mounts. It gets its own new element, or the detached one
   *  when that is its file and its chat is on screen, or nothing yet when it is
   *  its file and its chat is not (it is handed over once the chat is shown).
   *  Returns what the player calls as it unmounts. */
  mount(holder: Holder, source: MediaSource, create: () => MediaLike, bind: (el: MediaLike) => () => void): () => void {
    const slot: Slot = { holder, source, create, bind, el: null, unbind: null };
    this.slots.push(slot);
    const orphan = this.orphans.find((each) => sameFile(each.source, source));
    if (orphan) {
      this.orphans = this.orphans.filter((each) => each !== orphan);
      this.give(slot, orphan.el);
      return () => this.unmount(slot);
    }
    const held = this.detached;
    if (held && sameFile(held.source, source)) {
      if (source.chat !== null && this.shown.has(source.chat)) { this.adopt(slot); this.emit(); }
    } else {
      this.fill(slot);
    }
    return () => this.unmount(slot);
  }

  /** The chats the page shows now (`App`: the open chat while `chatShown`, the
   *  task chat beside it while that is on screen). */
  show(chats: ReadonlyArray<string | null>) {
    this.shown = new Set(chats.filter((chat): chat is string => !!chat));
    const leaving = this.slots.filter((slot) => slot.el && slot.source.chat !== null
      && !this.shown.has(slot.source.chat) && this.live(slot.el));
    if (leaving.length) {
      const pick = leaving.find((slot) => slot.el === this.lastPlayed) ?? leaving[leaving.length - 1];
      // One player goes with the person; anything else playing in a chat
      // nobody can see stops.
      for (const slot of leaving) if (slot !== pick) slot.el?.pause();
      const el = pick.el!;
      this.empty(pick);
      this.float(el, pick.source);
    }
    const held = this.detached;
    if (held?.pipOnLeave && held.source.chat && !this.shown.has(held.source.chat)) {
      held.pipOnLeave = false;
      if (held.mode === "mini") this.askPip(held);
    }
    this.settle();
    this.emit();
  }

  /** Play or pause the detached element (the mini-player's button). */
  toggle() {
    const el = this.detached?.el;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }

  /** Picture-in-picture for the detached video (the mini-player's button). */
  pip() {
    const held = this.detached;
    if (!held || held.source.kind !== "video") return;
    this.askPip(held);
    this.emit();
  }

  /** Back to the chat the detached element belongs to. */
  goBack() {
    const chat = this.detached?.source.chat;
    if (chat) this.back?.(chat);
  }

  /** Stop: the element is paused, its source released, and the slot it came
   *  from, still mounted or mounted later, starts again from nothing. */
  close() {
    if (this.detached) this.drop();
    this.emit();
  }

  /* ---- inside --------------------------------------------------------- */

  private live(el: MediaLike) {
    return (!el.paused && !el.ended) || this.env.pipElement() === el;
  }

  /** Listen once to every element the store holds. */
  private watch(el: MediaLike) {
    if (this.known.has(el)) return;
    this.known.add(el);
    el.addEventListener("play", () => this.played(el));
    el.addEventListener("pause", () => this.emit());
    el.addEventListener("ended", () => this.emit());
    el.addEventListener("enterpictureinpicture", () => {
      if (this.detached?.el === el && this.detached.mode !== "pip") { this.detached.mode = "pip"; this.emit(); }
    });
    el.addEventListener("leavepictureinpicture", () => this.leftPip(el));
  }

  private played(el: MediaLike) {
    this.lastPlayed = el;
    // Starting another player replaces the one that floats.
    if (this.detached && this.detached.el !== el) this.drop();
    this.emit();
  }

  private leftPip(el: MediaLike) {
    if (this.closing.has(el)) { this.closing.delete(el); return; }
    if (this.detached?.el !== el) return;
    // The browser pauses a video whose window is closed and leaves one that
    // goes "back to tab" playing; its pause event may come after this one.
    this.env.later(() => {
      const held = this.detached;
      if (held?.el !== el) return;
      if (el.paused) {
        held.mode = "parked";
        this.emit();
      } else {
        held.mode = "mini";
        this.emit();
        this.goBack();
      }
    }, 0);
  }

  private fill(slot: Slot) {
    const el = slot.create();
    this.watch(el);
    slot.holder.appendChild(el as never);
    slot.el = el;
    slot.unbind = slot.bind(el);
  }

  private give(slot: Slot, el: MediaLike) {
    slot.holder.appendChild(el as never);
    slot.el = el;
    slot.unbind = slot.bind(el);
  }

  private empty(slot: Slot) {
    slot.unbind?.();
    slot.unbind = null;
    slot.el = null;
  }

  private unmount(slot: Slot) {
    this.slots = this.slots.filter((each) => each !== slot);
    const el = slot.el;
    this.empty(slot);
    if (!el) return;
    if (slot.source.chat !== null && this.live(el)) {
      this.float(el, slot.source);
      // A row can be drawn again before the old one goes: the new slot for
      // the same file, in a chat still on screen, takes it at once.
      this.settle();
      this.emit();
      return;
    }
    const orphan = { el, source: slot.source };
    this.orphans.push(orphan);
    this.env.soon(() => {
      if (!this.orphans.includes(orphan)) return;
      this.orphans = this.orphans.filter((each) => each !== orphan);
      release(el);
    });
  }

  private float(el: MediaLike, source: MediaSource) {
    if (this.detached && this.detached.el !== el) this.drop();
    if (!this.host) { release(el); return; }
    this.host.appendChild(el as never);
    el.controls = false;
    const held: Detached = { el, source, mode: this.env.pipElement() === el ? "pip" : "mini" };
    this.detached = held;
    if (held.mode !== "mini" || source.kind !== "video") return;
    if (source.chat !== null && this.shown.has(source.chat)) held.pipOnLeave = true;
    else this.askPip(held);
  }

  private askPip(held: Detached) {
    const el = held.el;
    if (!this.env.pipEnabled() || !el.requestPictureInPicture || this.env.pipElement() === el) return;
    held.mode = "asking";
    const answered = (ok: boolean) => {
      if (this.detached !== held) {
        // Taken back before the browser answered: shut what it opened.
        if (ok && this.env.pipElement() === el) { this.closing.add(el); void this.env.exitPip().catch(() => {}); }
        return;
      }
      if (held.mode !== "asking") return;
      held.mode = ok ? "pip" : "mini";
      this.emit();
    };
    let request: Promise<unknown>;
    try {
      request = el.requestPictureInPicture();
    } catch {
      held.mode = "mini";
      return;
    }
    request.then(() => answered(true), () => answered(false));
    this.env.later(() => { if (this.detached === held && held.mode === "asking") { held.mode = "mini"; this.emit(); } }, PIP_ANSWER_MS);
  }

  /** The detached element back into its chat's slot. */
  private adopt(slot: Slot) {
    const held = this.detached!;
    this.detached = null;
    if (slot.el) { const own = slot.el; this.empty(slot); release(own); }
    held.el.controls = true;
    this.give(slot, held.el);
    if (this.env.pipElement() === held.el) {
      this.closing.add(held.el);
      void this.env.exitPip().catch(() => {});
    }
  }

  /** Hand the detached element to its chat's slot, if that chat is shown. */
  private settle() {
    const held = this.detached;
    const chat = held?.source.chat;
    if (!held || !chat || !this.shown.has(chat)) return;
    const slot = this.slots.find((each) => sameFile(each.source, held.source));
    if (slot) this.adopt(slot);
  }

  private drop() {
    const held = this.detached!;
    this.detached = null;
    if (this.env.pipElement() === held.el) {
      this.closing.add(held.el);
      void this.env.exitPip().catch(() => {});
    }
    release(held.el);
    // Slots that were waiting for it start again with their own element.
    for (const slot of this.slots) if (!slot.el && sameFile(slot.source, held.source)) this.fill(slot);
  }

  private emit() {
    const held = this.detached;
    const next: NowPlayingView | null = held && {
      source: held.source,
      mode: held.mode,
      paused: held.el.paused || held.el.ended,
      canPip: held.source.kind === "video" && this.env.pipEnabled() && !!held.el.requestPictureInPicture,
    };
    const same = next && this.view && next.source === this.view.source && next.mode === this.view.mode
      && next.paused === this.view.paused && next.canPip === this.view.canPip;
    if (same || (!next && !this.view)) return;
    this.view = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Stop an element and let its file go. */
function release(el: MediaLike) {
  el.pause();
  el.removeAttribute("src");
  try { el.load(); } catch { /* nothing to load */ }
  el.remove();
}

const browserEnv: Env = {
  pipElement: () => (typeof document === "undefined" ? null : document.pictureInPictureElement ?? null),
  pipEnabled: () => typeof document !== "undefined" && !!document.pictureInPictureEnabled,
  exitPip: () => (typeof document !== "undefined" && document.pictureInPictureElement ? document.exitPictureInPicture() : Promise.resolve()),
  later: (fn, ms) => { setTimeout(fn, ms); },
  soon: (fn) => queueMicrotask(fn),
};

/** The page's one store. */
export const nowPlaying = new NowPlaying(browserEnv);
