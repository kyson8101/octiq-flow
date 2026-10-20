// What an `ask_user` question shows, read off what the host sends
// (`__fixtures__/host/question_media_pending.json` and
// `question_answered_media.json`, recorded from the host's own test).
import { describe, expect, it } from "vitest";
import { hostFacts } from "./__fixtures__/hostFacts";
import { readQuestionAnswered } from "./question";
import { choicesOf, composeAnswer } from "./questionAnswer";
import { answeredItems, recordItems, withMediaOf } from "./questionBlock";
import { bytesLabel, chosenLabels, MEDIA_MAX, mediaCount, mediaList, optionImage, readMedia, shownMedia } from "./questionMedia";

const pending = hostFacts.questionMediaPending();
const [home, take] = pending.media!;

describe("a question's media, as the host lists it", () => {
  it("reads every entry the host sent, whole and in order", () => {
    expect(mediaList(pending.media)).toEqual(pending.media);
    expect(home).toMatchObject({ kind: "image", mime: "image/png", name: "home.png", caption: "The home screen today", bytes: 316 });
    expect(take).toMatchObject({ kind: "video", mime: "video/mp4", name: "take.mp4", bytes: 4012 });
    expect(take.caption).toBeUndefined();
  });

  it("reads the picture on an option, and nothing on one without", () => {
    const [keep, change] = choicesOf(pending.options);
    expect(keep).toEqual({ label: "Keep", image: (pending.options![0] as { image: unknown }).image });
    expect(change).toEqual({ label: "Change" });
  });

  it("drops an entry it cannot read and keeps the rest", () => {
    const raw = [null, "home.png", { ...home, id: "" }, { ...home, kind: "pdf" }, { ...home, path: 7 }, take];
    expect(mediaList(raw)).toEqual([take]);
    expect(mediaList("home.png")).toEqual([]);
    expect(mediaList(undefined)).toEqual([]);
  });

  it("is tolerant of what it can do without", () => {
    const bare = readMedia({ id: "x", kind: "audio", path: "/p/x/a.m4a" });
    expect(bare).toEqual({ id: "x", kind: "audio", mime: "", path: "/p/x/a.m4a", name: "a.m4a", bytes: 0 });
    expect(readMedia({ ...home, caption: "  " })?.caption).toBeUndefined();
  });

  it("shows no more than the host allows", () => {
    expect(mediaList(Array.from({ length: 6 }, (_, i) => ({ ...home, id: `m${i}` })))).toHaveLength(MEDIA_MAX);
  });

  it("takes only a picture for an option, and keeps the option whatever it holds", () => {
    expect(optionImage(take)).toBeUndefined();
    expect(optionImage({ broken: true })).toBeUndefined();
    expect(choicesOf([{ label: "Keep", image: take }, { label: "Bad", image: "/abs/face.png" }])).toEqual([{ label: "Keep" }, { label: "Bad" }]);
  });
});

describe("the answered line's media", () => {
  const line = hostFacts.questionAnsweredMedia();

  it("is read off the host's line, on the question and on the option", () => {
    const read = readQuestionAnswered(line)!;
    expect(read.questions[0].media).toEqual(line.questions[0].media);
    expect(read.questions[0].options[0].image).toEqual(line.questions[0].options[0].image);
    expect(read.questions[0].options[1]).toEqual({ label: "Change" });
  });

  it("does not cost the line its question when an entry will not read", () => {
    const raw = structuredClone(line) as unknown as { questions: Record<string, unknown>[] };
    raw.questions[0].media = [{ kind: "image" }];
    (raw.questions[0].options as Record<string, unknown>[])[0].image = { id: "x" };
    const read = readQuestionAnswered(raw)!;
    expect(read.questions[0].question).toBe("Which layout should the home screen keep?");
    expect(read.questions[0].media).toBeUndefined();
    expect(read.questions[0].options[0]).toEqual({ label: "Keep" });
  });

  it("shows what the question showed, then the picture of the option chosen", () => {
    const [item] = answeredItems(readQuestionAnswered(line)!);
    expect(item.media!.map((m) => [m.name, m.option])).toEqual([["home.png", undefined], ["take.mp4", undefined], ["face.png", "Keep"]]);
  });

  it("shows no option's picture the answer did not choose", () => {
    const read = readQuestionAnswered({ ...line, questions: [{ ...line.questions[0], answer: "Change" }] })!;
    expect(answeredItems(read)[0].media!.map((m) => m.name)).toEqual(["home.png", "take.mp4"]);
  });

  it("is drawn the same from the listed record once it has an answer", () => {
    const [item] = recordItems([{ ...pending, answer: "Keep" }]);
    expect(item).toEqual(answeredItems(readQuestionAnswered(line)!)[0]);
    // An answer this page sent, before the host's own word for it.
    expect(recordItems([pending], ["Keep"])[0].media).toHaveLength(3);
  });

  it("is lent to a call's own result only where the words asked are the same", () => {
    const record = answeredItems(readQuestionAnswered(line)!);
    const own = [{ question: line.questions[0].question, answer: "Keep" }];
    expect(withMediaOf(own, record)[0].media).toEqual(record[0].media);
    const other = [{ question: "Something else?", answer: "Keep" }];
    expect(withMediaOf(other, record)).toEqual(other);
    expect(withMediaOf(own, null)).toBe(own);
  });
});

describe("which options an answer chose", () => {
  const labels = ["Keep", "Change, then ship", "Drop"];
  it("is the one label of a one-of", () => {
    expect(chosenLabels("Keep", labels, false)).toEqual(["Keep"]);
    expect(chosenLabels("Something I typed", labels, false)).toEqual([]);
  });
  it("reads a set the way the page writes it, labels with a comma and a typed tail included", () => {
    expect(chosenLabels("Keep, Change, then ship", labels, true)).toEqual(["Keep", "Change, then ship"]);
    expect(chosenLabels("Keep, Drop, and a note", labels, true)).toEqual(["Keep", "Drop"]);
    expect(chosenLabels("", labels, true)).toEqual([]);
  });
  it("prefers a reading of whole labels, so one label that starts another is not taken for it", () => {
    const prefix = ["A", "A, B"];
    expect(chosenLabels("A, B", prefix, true)).toEqual(["A, B"]);
    expect(chosenLabels("A", prefix, true)).toEqual(["A"]);
    expect(chosenLabels("A, A, B", prefix, true)).toEqual(["A", "A, B"]);
    const comma = ["Red, green", "Blue", "Red"];
    expect(chosenLabels("Red, green, Red", comma, true)).toEqual(["Red, green", "Red"]);
    expect(chosenLabels("Blue, Red, and teal", comma, true)).toEqual(["Blue", "Red"]);
  });
  it("names no option when the answer reads two ways", () => {
    // `A, B, C` is A then the typed `B, C`, or `A, B` then the typed `C`.
    expect(chosenLabels("A, B, C", ["A", "A, B"], true)).toEqual([]);
    // Two whole readings: `X, Y` alone, or `X` then `Y`.
    expect(chosenLabels("X, Y", ["X", "X, Y", "Y"], true)).toEqual([]);
  });
  it("marks the image of the option that was chosen, not one whose label starts it", () => {
    const [a, ab] = [{ ...home, id: "a" }, { ...home, id: "ab" }];
    const question = { multiple: true, options: [{ label: "A", image: a }, { label: "A, B", image: ab }] };
    expect(shownMedia(question, composeAnswer(["A", "A, B"], ["A, B"], "")).map((m) => [m.id, m.option])).toEqual([["ab", "A, B"]]);
    expect(shownMedia(question, "A, B, C")).toEqual([]);
  });
  it("takes the media of a question with no options as its own", () => {
    expect(shownMedia({ media: pending.media }, "anything")).toEqual(pending.media);
  });
});

describe("words for media", () => {
  it("says a size and a count", () => {
    expect([bytesLabel(316), bytesLabel(4012), bytesLabel(2.5 * 1024 * 1024), bytesLabel(200 * 1024 * 1024)]).toEqual(["316 B", "4 KB", "2.5 MB", "200 MB"]);
    expect(mediaCount([home, take, home])).toBe("2 images, 1 video");
    expect(mediaCount([{ kind: "audio" }])).toBe("1 recording");
  });
});
