import type { CSSProperties } from "react";
import { applyTheme, oppositeThemeId, themeById } from "../lib/themeStore";
import { useThemeId } from "../lib/useThemeId";
import "./AppearanceToggle.css";

// One physical grid: the same LEDs re-light as the knob travels. Integer
// centres on an 18px SVG keep the dots distinct at both DPR 1 and DPR 2.
const MOON = [
  "000000010",
  "001110111",
  "011100010",
  "111100000",
  "111000000",
  "111100000",
  "011100000",
  "001110000",
  "000000000",
].join("");
const SUN = [
  "000010000",
  "010010010",
  "001000100",
  "000111000",
  "110111011",
  "000111000",
  "001000100",
  "010010010",
  "000010000",
].join("");

export function AppearanceToggle() {
  const id = useThemeId();
  const dark = themeById(id).scheme === "dark";
  const bitmap = dark ? MOON : SUN;
  return (
    <button className="appearance-toggle" type="button" role="switch"
      aria-label="Dark mode" aria-checked={dark}
      title={`Switch to ${themeById(oppositeThemeId(id)).name}`}
      onClick={() => applyTheme(oppositeThemeId())}>
      <span className="appearance-toggle-track" aria-hidden="true">
        <span className="appearance-toggle-knob">
          <svg width="18" height="18" viewBox="0 0 18 18" focusable="false">
            {Array.from(bitmap, (pixel, index) => (
              <circle key={index} cx={1 + (index % 9) * 2} cy={1 + Math.floor(index / 9) * 2} r="0.65"
                className="appearance-toggle-dot" data-lit={pixel === "1"}
                style={{ "--dot-delay": `${((index % 9) + Math.floor(index / 9)) * 5}ms` } as CSSProperties} />
            ))}
          </svg>
        </span>
      </span>
    </button>
  );
}
