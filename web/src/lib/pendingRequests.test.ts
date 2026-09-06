import { describe, expect, it } from "vitest";
import { PendingRequests, type PendingRequest } from "./pendingRequests";

type Request = PendingRequest & { text: string };
const request = (id: string, chat = "one"): Request => ({ id, chatKey: `chat:${chat}`, text: id });
const ids = (store: PendingRequests<Request>) => Object.values(store.current).flat().map((item) => item.id);

describe("pending request snapshot reconciliation", () => {
  it("replaces stale requests with the server snapshot on reconnect", () => {
    const store = new PendingRequests<Request>();
    store.add(request("old"));
    const token = store.begin();
    store.finish(token, [request("current", "two")]);
    expect(store.current).toEqual({ two: [request("current", "two")] });
  });

  it("preserves a request broadcast while the older snapshot was in flight", () => {
    const store = new PendingRequests<Request>();
    const token = store.begin();
    store.add(request("new"));
    store.finish(token, [request("earlier")]);
    expect(ids(store)).toEqual(["earlier", "new"]);
  });

  it("keeps newer event content without duplicating a request also in the snapshot", () => {
    const store = new PendingRequests<Request>();
    const token = store.begin();
    store.add({ ...request("same"), text: "newer" });
    store.finish(token, [request("same"), request("same")]);
    expect(store.current.one).toEqual([{ ...request("same"), text: "newer" }]);
  });

  it("does not resurrect a locally answered question batch", () => {
    const store = new PendingRequests<Request>();
    store.add(request("question-1"));
    store.add(request("question-2"));
    const token = store.begin();
    store.replace((previous) => ({ ...previous, one: previous.one.filter((item) => !item.id.startsWith("question-")) }));
    store.finish(token, [request("question-1"), request("question-2"), request("unrelated", "two")]);
    expect(ids(store)).toEqual(["unrelated"]);
  });

  it("remembers an expiry received before the request itself was loaded", () => {
    const store = new PendingRequests<Request>();
    const token = store.begin();
    store.remove("expired");
    store.finish(token, [request("expired"), request("valid")]);
    expect(ids(store)).toEqual(["valid"]);
  });

  it("keeps the final event when a request arrives and expires during refill", () => {
    const store = new PendingRequests<Request>();
    const token = store.begin();
    store.add(request("brief"));
    store.remove("brief");
    store.finish(token, [request("brief")]);
    expect(ids(store)).toEqual([]);
  });

  it("ignores replies from an earlier connection without cancelling the new refill", () => {
    const store = new PendingRequests<Request>();
    const oldToken = store.begin();
    store.cancel(oldToken);
    const newToken = store.begin();
    store.add(request("new-live"));
    expect(store.finish(oldToken, [request("stale")])).toBeNull();
    store.cancel(oldToken);
    store.finish(newToken, []);
    expect(ids(store)).toEqual(["new-live"]);
  });

  it("continues accepting events and local answers when the pending command fails", () => {
    const store = new PendingRequests<Request>();
    const token = store.begin();
    store.cancel(token);
    store.add(request("live"));
    store.replace((previous) => ({ ...previous, one: [] }));
    expect(ids(store)).toEqual([]);
    expect(store.finish(token, [request("live")])).toBeNull();
  });

  it("drops non-chat and malformed identity rows without losing valid items", () => {
    const store = new PendingRequests<Request>();
    const token = store.begin();
    store.finish(token, [{ id: "terminal", chatKey: "term:one", text: "no" }, { ...request(""), chatKey: "chat:" }, request("valid")]);
    expect(ids(store)).toEqual(["valid"]);
  });

  it("does not retain tombstones across separate snapshots", () => {
    const store = new PendingRequests<Request>();
    const first = store.begin();
    store.remove("same");
    store.finish(first, [request("same")]);
    const second = store.begin();
    store.finish(second, [request("same")]);
    expect(ids(store)).toEqual(["same"]);
  });
});
