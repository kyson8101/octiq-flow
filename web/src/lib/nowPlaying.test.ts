import { describe, expect, it } from "vitest";
import { NowPlaying, PIP_ANSWER_MS, type Env, type MediaKind, type MediaLike, type MediaSource } from "./nowPlaying";

/** A holder that records what it holds, the way a DOM node would. */
class FakeHolder {
  constructor(public name: string) {}
  appendChild(node: never) { (node as FakeMedia).moveTo(this); }
}

/** A media element: paused or playing, in one holder at a time. Moving it
 *  never pauses it, which is what the browser does inside one task. */
class FakeMedia implements MediaLike {
  paused = true;
  ended = false;
  controls = true;
  error: { message: string; code: number } | null = null;
  currentTime = 0;
  src: string | null;
  holder: FakeHolder | null = null;
  moves = 0;
  private handlers = new Map<string, Array<() => void>>();
  pipRequests = 0;
  constructor(public kind: MediaKind, public pipAnswer: "yes" | "no" | "never", private world: World) {
    this.src = `/file?path=${kind}`;
  }
  requestPictureInPicture = () => {
    this.pipRequests++;
    if (this.pipAnswer === "never") return new Promise<unknown>(() => {});
    if (this.pipAnswer === "no") return Promise.reject(new Error("NotAllowedError"));
    this.world.pip = this;
    this.fire("enterpictureinpicture");
    return Promise.resolve({});
  };
  moveTo(holder: FakeHolder) { this.holder = holder; this.moves++; }
  async play() { this.paused = false; this.fire("play"); }
  pause() { if (this.paused) return; this.paused = true; this.fire("pause"); }
  load() {}
  remove() { this.holder = null; }
  removeAttribute(name: string) { if (name === "src") this.src = null; }
  addEventListener(type: string, fn: () => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  fire(type: string) { for (const fn of this.handlers.get(type) ?? []) fn(); }
}

class World implements Env {
  pip: FakeMedia | null = null;
  enabled = true;
  queue: Array<{ fn: () => void; at: number }> = [];
  now = 0;
  exits = 0;
  active = false;
  tabActive() { return this.active; }
  pipElement() { return this.pip; }
  pipEnabled() { return this.enabled; }
  async exitPip() {
    this.exits++;
    const was = this.pip;
    this.pip = null;
    was?.fire("leavepictureinpicture");
  }
  later(fn: () => void, ms: number) { this.queue.push({ fn, at: this.now + ms }); }
  soon(fn: () => void) { queueMicrotask(fn); }
  run(ms = 0) {
    this.now += ms;
    const due = this.queue.filter((each) => each.at <= this.now);
    this.queue = this.queue.filter((each) => each.at > this.now);
    for (const each of due) each.fn();
  }
}

const flush = () => new Promise((done) => setTimeout(done, 0));

function setup({ pip = "yes" as "yes" | "no" | "never", enabled = true } = {}) {
  const world = new World();
  world.enabled = enabled;
  const store = new NowPlaying(world);
  const host = new FakeHolder("host");
  store.setHost(host);
  const opened: string[] = [];
  store.setBack((chat) => opened.push(chat));
  const made: FakeMedia[] = [];
  const bound: FakeMedia[] = [];
  const mount = (chat: string | null, path: string, kind: MediaKind = "video", reply = "reply-1") => {
    const slot = new FakeHolder(`${chat}:${path}`);
    const source: MediaSource = { chat, reply, path, kind, name: path.split("/").pop()! };
    const unmount = store.mount(slot, source, () => {
      const el = new FakeMedia(kind, pip, world);
      made.push(el);
      return el;
    }, (el) => { bound.push(el as FakeMedia); return () => {}; });
    return { slot, unmount };
  };
  return { world, store, host, opened, made, bound, mount };
}

describe("now playing", () => {
  it("returns a repeated path to its own reply without replacing another reply's player", async () => {
    const { store, made, mount } = setup({ enabled: false });
    store.show(["A"]);
    const first = mount("A", "/same.mp4", "video", "reply-1");
    const second = mount("A", "/same.mp4", "video", "reply-2");
    const playing = made[1];
    await playing.play();
    second.unmount();
    first.unmount();
    store.show(["B"]);
    expect(store.holds("A", "/same.mp4", "reply-1")).toBe(false);
    expect(store.holds("A", "/same.mp4", "reply-2")).toBe(true);
    const newFirst = mount("A", "/same.mp4", "video", "reply-1");
    const newSecond = mount("A", "/same.mp4", "video", "reply-2");
    const other = made[0];
    store.show(["A"]);
    expect(playing.holder).toBe(newSecond.slot);
    expect(playing.paused).toBe(false);
    expect(other.holder).toBe(newFirst.slot);
    expect(other.src).not.toBeNull();
  });

  it.each(["delete chat", "/clear"])("%s releases detached playback and closes PiP without refilling the dying slot", async () => {
    const { store, world, made, mount, opened } = setup();
    store.show(["A"]);
    const a = mount("A", "/same.mp4");
    await made[0].play();
    store.show(["B"]);
    await flush();
    store.forget("A");
    a.unmount();
    world.run();
    store.goBack();
    expect(made).toHaveLength(1);
    expect(made[0].paused).toBe(true);
    expect(made[0].src).toBeNull();
    expect(made[0].holder).toBeNull();
    expect(world.pip).toBeNull();
    expect(store.snapshot()).toBeNull();
    expect(opened).toEqual([]);
  });

  it("removing the playing reply releases it but keeps other replies of that chat", async () => {
    const { store, made, mount } = setup({ enabled: false });
    store.show(["A"]);
    const a = mount("A", "/same.mp4", "video", "reply-1");
    const b = mount("A", "/same.mp4", "video", "reply-2");
    await made[0].play();
    store.show(["B"]);
    a.unmount();
    store.retainReplies("A", new Set(["reply-2"]));
    expect(store.snapshot()).toBeNull();
    expect(made[0].src).toBeNull();
    expect(made[1].src).not.toBeNull();
    b.unmount();
  });

  it("forgetting a reply also releases its paused orphan before a remount can adopt it", () => {
    const { store, made, mount } = setup();
    const a = mount("A", "/same.mp4");
    a.unmount();
    store.forget("A", "reply-1");
    mount("A", "/same.mp4");
    expect(made).toHaveLength(2);
    expect(made[0].src).toBeNull();
  });

  it("deleting a reply also closes PiP opened while the reply was still inline", async () => {
    const { store, world, made, mount } = setup();
    store.show(["A"]);
    mount("A", "/same.mp4");
    await made[0].requestPictureInPicture();
    store.forget("A", "reply-1");
    expect(world.pip).toBeNull();
    expect(made[0].src).toBeNull();
  });

  it("keeps a detached media error and gives it back with the element on return", async () => {
    const { store, made, mount } = setup({ enabled: false });
    store.show(["A"]);
    const a = mount("A", "/bad.mp4");
    const el = made[0];
    await el.play();
    a.unmount();
    store.show(["B"]);
    el.error = { code: 4, message: "Decode failed" };
    el.fire("error");
    expect(store.snapshot()).toMatchObject({ paused: true, error: "Decode failed", mode: "mini", canPip: false });
    const again = mount("A", "/bad.mp4");
    store.show(["A"]);
    expect(el.holder).toBe(again.slot);
    expect(store.errorOf(el)).toBe("Decode failed");
    // The native error may be reset by the browser; the held failure is not.
    el.error = null;
    expect(store.errorOf(el)).toBe("Decode failed");
  });

  it("paused PiP Back to tab opens its source chat when the tab regains focus", async () => {
    const { store, world, made, mount, opened } = setup();
    store.show(["A"]);
    const a = mount("A", "/same.mp4");
    await made[0].play();
    a.unmount();
    store.show(["B"]);
    await flush();
    made[0].pause();
    world.active = true;
    world.pip = null;
    made[0].fire("leavepictureinpicture");
    world.run();
    expect(opened).toEqual(["A"]);
    expect(store.snapshot()?.mode).toBe("mini");
  });

  it("a player gets its own element, in its own slot", () => {
    const { store, made, mount } = setup();
    store.show(["A"]);
    const { slot } = mount("A", "/x/take.mp4");
    expect(made).toHaveLength(1);
    expect(made[0].holder).toBe(slot);
    expect(store.snapshot()).toBeNull();
  });

  it("a playing video goes to the host when its chat unmounts, and asks for picture-in-picture", async () => {
    const { world, store, host, made, mount } = setup();
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    const el = made[0];
    await el.play();
    el.currentTime = 12.5;
    // React unmounts the old transcript before App says what is shown.
    unmount();
    expect(el.holder).toBe(host);
    expect(el.paused).toBe(false);
    expect(el.src).not.toBeNull();
    expect(el.pipRequests).toBe(0);
    store.show(["B"]);
    expect(el.pipRequests).toBe(1);
    await flush();
    expect(world.pip).toBe(el);
    expect(store.snapshot()).toMatchObject({ mode: "pip", paused: false, source: { chat: "A", path: "/x/take.mp4" } });
    expect(el.currentTime).toBe(12.5);
    expect(el.controls).toBe(false);
  });

  it("falls back to the mini-player when picture-in-picture is refused", async () => {
    const { store, made, mount } = setup({ pip: "no" });
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    await made[0].play();
    unmount();
    store.show(["B"]);
    expect(store.snapshot()?.mode).toBe("asking");
    await flush();
    expect(store.snapshot()).toMatchObject({ mode: "mini", canPip: true });
  });

  it("and when the browser never answers", () => {
    const { world, store, made, mount } = setup({ pip: "never" });
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    void made[0].play();
    unmount();
    store.show(["B"]);
    expect(store.snapshot()?.mode).toBe("asking");
    world.run(PIP_ANSWER_MS);
    expect(store.snapshot()?.mode).toBe("mini");
  });

  it("does not ask where picture-in-picture is not offered, and never for audio", async () => {
    const off = setup({ enabled: false });
    off.store.show(["A"]);
    const video = off.mount("A", "/x/take.mp4");
    await off.made[0].play();
    video.unmount();
    off.store.show(["B"]);
    expect(off.made[0].pipRequests).toBe(0);
    expect(off.store.snapshot()).toMatchObject({ mode: "mini", canPip: false });

    const on = setup();
    on.store.show(["A"]);
    const audio = on.mount("A", "/x/voice.m4a", "audio");
    await on.made[0].play();
    audio.unmount();
    on.store.show(["B"]);
    expect(on.made[0].pipRequests).toBe(0);
    expect(on.store.snapshot()).toMatchObject({ mode: "mini", canPip: false });
  });

  it("paused media does not float: it is released with its slot", async () => {
    const { store, made, mount } = setup();
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    unmount();
    store.show(["B"]);
    await flush();
    expect(made[0].src).toBeNull();
    expect(made[0].holder).toBeNull();
    expect(store.snapshot()).toBeNull();
  });

  it("a player outside a chat (the file dock) never floats", async () => {
    const { store, made, mount } = setup();
    const { unmount } = mount(null, "/x/take.mp4");
    await made[0].play();
    unmount();
    await flush();
    expect(made[0].src).toBeNull();
    expect(store.snapshot()).toBeNull();
  });

  it("a row drawn again before the old one goes takes the playing element over", async () => {
    const { store, made, mount } = setup();
    store.show(["A"]);
    const old = mount("A", "/x/take.mp4");
    const el = made[0];
    await el.play();
    const fresh = mount("A", "/x/take.mp4");
    expect(made).toHaveLength(2);
    old.unmount();
    expect(el.holder).toBe(fresh.slot);
    expect(el.paused).toBe(false);
    expect(made[1].src).toBeNull();
    expect(el.pipRequests).toBe(0);
    expect(store.snapshot()).toBeNull();
  });

  it("the old row going first, then the new one: the view says nothing floats", async () => {
    const { store, made, mount } = setup();
    store.show(["A"]);
    const old = mount("A", "/x/take.mp4");
    await made[0].play();
    let heard = 0;
    store.subscribe(() => heard++);
    old.unmount();
    expect(store.snapshot()?.mode).toBe("mini");
    mount("A", "/x/take.mp4");
    expect(store.snapshot()).toBeNull();
    expect(heard).toBe(2);
  });

  it("a row remounted in the same commit takes its paused element back, where it was", async () => {
    const { store, made, mount } = setup();
    store.show(["A"]);
    const first = mount("A", "/x/take.mp4");
    const el = made[0];
    el.currentTime = 33;
    first.unmount();
    const again = mount("A", "/x/take.mp4");
    await flush();
    expect(made).toHaveLength(1);
    expect(el.holder).toBe(again.slot);
    expect(el.src).not.toBeNull();
    expect(el.currentTime).toBe(33);
  });

  it("a chat hidden behind a page hands its playing element over without unmounting", async () => {
    const { store, host, made, mount } = setup({ pip: "no" });
    store.show(["A"]);
    const { slot } = mount("A", "/x/voice.m4a", "audio");
    const el = made[0];
    await el.play();
    store.show([]);
    expect(el.holder).toBe(host);
    expect(store.snapshot()?.mode).toBe("mini");
    // The chat is back: the same element goes back into the same slot, still playing.
    store.show(["A"]);
    expect(el.holder).toBe(slot);
    expect(el.paused).toBe(false);
    expect(el.controls).toBe(true);
    expect(store.snapshot()).toBeNull();
    expect(made).toHaveLength(1);
  });

  it("returning to the chat gives the remounted slot the same element, and closes picture-in-picture", async () => {
    const { world, store, made, bound, mount } = setup();
    store.show(["A"]);
    const first = mount("A", "/x/take.mp4");
    const el = made[0];
    await el.play();
    el.currentTime = 40;
    first.unmount();
    store.show(["B"]);
    await flush();
    expect(world.pip).toBe(el);
    expect(store.holds("A", "/x/take.mp4", "reply-1")).toBe(true);
    // Back to A: the slot mounts before App says A is shown (children's layout
    // effects run first). It waits rather than make a second element.
    const again = mount("A", "/x/take.mp4");
    expect(made).toHaveLength(1);
    store.show(["A"]);
    expect(el.holder).toBe(again.slot);
    expect(el.currentTime).toBe(40);
    expect(el.paused).toBe(false);
    expect(bound.at(-1)).toBe(el);
    await flush();
    expect(world.pip).toBeNull();
    expect(world.exits).toBe(1);
    expect(store.snapshot()).toBeNull();
  });

  it("with no slot for it in its chat, keeps playing in the host", async () => {
    const { store, host, made, mount } = setup({ pip: "no" });
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    await made[0].play();
    unmount();
    store.show(["B"]);
    store.show(["A"]);
    expect(made[0].holder).toBe(host);
    expect(made[0].paused).toBe(false);
    expect(store.snapshot()?.source.chat).toBe("A");
  });

  it("starting another player replaces the floating one; never two playing", async () => {
    const { store, made, mount } = setup({ pip: "no" });
    store.show(["A"]);
    const a = mount("A", "/x/take.mp4");
    await made[0].play();
    a.unmount();
    store.show(["B"]);
    mount("B", "/x/other.mp4");
    await made[1].play();
    expect(made[0].paused).toBe(true);
    expect(made[0].src).toBeNull();
    expect(store.snapshot()).toBeNull();
  });

  it("only one player leaves a chat; anything else playing there stops", async () => {
    const { store, host, made, mount } = setup({ pip: "no" });
    store.show(["A"]);
    mount("A", "/x/one.mp4");
    mount("A", "/x/two.m4a", "audio");
    await made[0].play();
    await made[1].play();
    store.show(["B"]);
    expect(made[1].holder).toBe(host);
    expect(made[0].paused).toBe(true);
    expect(store.snapshot()?.source.path).toBe("/x/two.m4a");
  });

  it("closing stops it, releases the file, and a waiting slot starts again from nothing", async () => {
    const { store, made, mount } = setup({ pip: "no" });
    store.show(["A"]);
    const { slot } = mount("A", "/x/take.mp4");
    await made[0].play();
    store.show(["B"]);
    store.close();
    expect(made[0].paused).toBe(true);
    expect(made[0].src).toBeNull();
    expect(store.snapshot()).toBeNull();
    expect(made).toHaveLength(2);
    expect(made[1].holder).toBe(slot);
    expect(made[1].paused).toBe(true);
  });

  it("the mini-player's buttons: play and pause, and back to the chat", async () => {
    const { store, made, mount, opened } = setup({ pip: "no" });
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    await made[0].play();
    unmount();
    store.show(["B"]);
    store.toggle();
    expect(made[0].paused).toBe(true);
    expect(store.snapshot()?.paused).toBe(true);
    store.toggle();
    await flush();
    expect(store.snapshot()?.paused).toBe(false);
    store.goBack();
    expect(opened).toEqual(["A"]);
  });

  it("the browser's window closed: the paused video keeps a visible Back fallback", async () => {
    const { world, store, made, mount, opened } = setup();
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    const el = made[0];
    await el.play();
    unmount();
    store.show(["B"]);
    await flush();
    // Chrome pauses the video it closes.
    world.pip = null;
    el.pause();
    el.fire("leavepictureinpicture");
    world.run();
    expect(store.snapshot()?.mode).toBe("mini");
    expect(opened).toEqual([]);
    expect(el.src).not.toBeNull();
    // Its chat again: the inline player is back where it stopped, paused.
    const again = mount("A", "/x/take.mp4");
    store.show(["A"]);
    expect(el.holder).toBe(again.slot);
    expect(el.paused).toBe(true);
  });

  it("the browser's window sent back to the tab: the page opens its chat", async () => {
    const { world, store, made, mount, opened } = setup();
    store.show(["A"]);
    const { unmount } = mount("A", "/x/take.mp4");
    const el = made[0];
    await el.play();
    unmount();
    store.show(["B"]);
    await flush();
    world.pip = null;
    el.fire("leavepictureinpicture");
    world.run();
    expect(opened).toEqual(["A"]);
  });

  it("a slot re-rendered in its own chat does not open a picture-in-picture window", async () => {
    const { store, made, mount } = setup();
    store.show(["A"]);
    const first = mount("A", "/x/take.mp4");
    const el = made[0];
    await el.play();
    first.unmount();
    const again = mount("A", "/x/take.mp4");
    store.show(["A"]);
    expect(el.pipRequests).toBe(0);
    expect(el.holder).toBe(again.slot);
    expect(store.snapshot()).toBeNull();
  });

  it("taken back before the browser answered, the window it opens is shut", async () => {
    const { world, store, made, mount } = setup();
    store.show(["A"]);
    const first = mount("A", "/x/take.mp4");
    const el = made[0];
    await el.play();
    first.unmount();
    store.show(["B"]);
    // Same task: the person is already back.
    const again = mount("A", "/x/take.mp4");
    store.show(["A"]);
    expect(el.holder).toBe(again.slot);
    await flush();
    await flush();
    expect(world.pip).toBeNull();
  });
});
