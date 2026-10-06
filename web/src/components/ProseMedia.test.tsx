import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({
  bridge: {
    fetchFile: async () => new Blob(),
    fileUrl: (path: string) => `/file?path=${encodeURIComponent(path)}`,
  },
}));

import { ProsePage, ProsePdf, ProsePlayer } from "./ProseMedia";

describe("files a reply names, shown under it", () => {
  it("fetches nothing before it is near the screen", () => {
    for (const html of [
      renderToStaticMarkup(<ProsePlayer path="/x/demo.mp4" kind="video" />),
      renderToStaticMarkup(<ProsePlayer path="/x/take.mp3" kind="audio" />),
      renderToStaticMarkup(<ProsePdf path="/x/report.pdf" />),
    ]) {
      expect(html).toContain("prose-media-wait");
      expect(html).not.toMatch(/<(video|audio|iframe)/);
    }
  });

  it("keeps an HTML page shut until asked, with a way to open it in a tab", () => {
    const html = renderToStaticMarkup(<ProsePage path="/x/site/index.html" />);
    expect(html).toContain("index.html");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Show here<");
    expect(html).toContain(">Open<");
    expect(html).not.toContain("<iframe");
  });
});
