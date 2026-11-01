import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaybackSpeed } from "./PlaybackSpeed";

it("names the current speed and cannot submit a question's form", () => {
  const html = renderToStaticMarkup(<PlaybackSpeed element={null} />);
  expect(html).toContain('type="button"');
  expect(html).toContain('aria-label="Playback speed, 1×"');
  expect(html).toContain('disabled=""');
  expect(html).toContain('>1×</button>');
});
