#!/usr/bin/env python3
"""Write the preset theme files in web/src/lib/themes/.

The three original themes were pasted verbatim out of tweakcn. These are ours,
and they are GENERATED rather than hand-written for one reason: the app does not
read a theme's colours as decoration, it reasons about them. `theme.ts` builds a
three-step background ladder off `card`, picks `--ok` and `--warn` out of the
chart colours BY HUE, and puts `primary-foreground` text on a `primary` fill.
Two dozen palettes hand-typed would each be a fresh chance to break one of those
quietly — a card darker than its background, no green within 35 degrees of 145,
white text on a pale yellow accent.

So the rules live here once, as arithmetic, and `audit()` refuses to let a theme
out that breaks one:

  · `card` is always lighter than `background`, and `sidebar` sits between them
  · chart 3 is always a green near hue 145 and chart 4 an amber near 85, which
    is where `--ok` and `--warn` come from
  · the accent stays out of the lightness band where neither a white nor a black
    label reads on it

Only the `.dark` block is ever applied (see CLAUDE.md). The `:root` block is
written anyway so the files match the shape of a real tweakcn export.

A NOTE ON THE FOUR STYLE THEMES. Brutalism, Neumorphism, Liquid Glass and
Metronic are named after design languages, and a design language is mostly
things this system cannot set: themes carry colours and corner radii, never
shadows, blur or border WIDTH (CLAUDE.md). So they are interpretations, not
implementations — brutalism gets a stark ladder and a hard bright border where
it would want thick black rules; liquid glass gets luminous, tinted, well
separated panes where it would want a backdrop filter. They are honest about
being the colour half of the idea.

    python3 scripts/generate_themes.py          # rewrite every theme file
    python3 scripts/generate_themes.py --check  # run the audit, write nothing
"""

import argparse
import pathlib
import re
import sys

OUT = pathlib.Path(__file__).resolve().parent.parent / "web" / "src" / "lib" / "themes"

# Where `theme.ts` looks for the two colours that carry meaning rather than
# taste. Kept as constants so a change there is a one-line change here.
OK_HUE, WARN_HUE = 145, 85

# The accent carries a text label, and there is a band where NEITHER colour
# works: too light for white to stand out, too dark for black. Accents are
# pushed out of it rather than left sitting in the middle looking muddy.
#
#   ≤ 0.62     white label, comfortably
#   0.62–0.72  the dead band — snapped down to 0.62
#   ≥ 0.72     near-black label, comfortably
DARK_LABEL = 0.72
WHITE_LABEL = 0.62

# The lightness ladder every theme uses unless it says otherwise. These are the
# numbers that make a dark UI legible: surfaces far enough apart to be told
# apart, text far enough from the surface to be read off it.
SURFACE = dict(
    bg=0.1750,
    sidebar=0.1980,   # the top bar: its own surface, between bg and card
    card=0.2200,
    popover=0.2450,
    muted=0.2700,
    hover=0.3200,     # shadcn's `accent` — a quiet hover tint, not the brand
    border=0.3100,
    input=0.3800,
    fg=0.9550,
    dim=0.7100,       # muted-foreground
)

# id, name, bg hue, bg chroma, accent (l, c, h), radius, surface overrides
#
# Background chroma is kept tiny — this is the colour of a whole screen, and
# what reads as "a warm dark grey" at 0.02 reads as "brown" at 0.06. The accent
# is the only place a theme is allowed to be loud.
SPECS = [
    ("midnight",    "Midnight",     265, 0.020, (0.66, 0.170, 258), 0.5,   {}),
    ("aurora",      "Aurora",       190, 0.022, (0.78, 0.150, 168), 0.5,   {}),
    ("ember",       "Ember",         45, 0.014, (0.70, 0.180,  42), 0.375, {}),
    ("orchid",      "Orchid",       310, 0.024, (0.72, 0.170, 320), 0.75,  {}),
    ("moss",        "Moss",         145, 0.018, (0.74, 0.140, 140), 0.5,   {}),
    ("cobalt",      "Cobalt",       250, 0.045, (0.72, 0.160, 235), 0.375, {}),
    ("rosewood",    "Rosewood",     350, 0.022, (0.74, 0.130,  12), 0.625, {}),
    ("graphite",    "Graphite",     250, 0.006, (0.70, 0.100, 230), 0.25,  {}),
    ("saffron",     "Saffron",       70, 0.012, (0.80, 0.160,  80), 0.5,   {}),
    ("glacier",     "Glacier",      230, 0.020, (0.80, 0.120, 205), 0.625, {}),
    ("vineyard",    "Vineyard",     355, 0.030, (0.62, 0.190,   5), 0.375, {}),
    ("harbour",     "Harbour",      220, 0.020, (0.72, 0.110, 195), 0.5,   {}),
    ("cinder",      "Cinder",        30, 0.010, (0.66, 0.200,  28), 0.25,  {}),
    ("lagoon",      "Lagoon",       200, 0.030, (0.78, 0.140, 190), 0.625, {}),
    ("lilac-ash",   "Lilac Ash",    290, 0.016, (0.78, 0.100, 295), 0.75,  {}),
    ("copper",      "Copper",        50, 0.018, (0.68, 0.140,  55), 0.375, {}),
    ("neon",        "Neon",         300, 0.020, (0.72, 0.240, 330), 0.0,   {}),
    ("sage",        "Sage",         150, 0.010, (0.76, 0.080, 155), 0.5,   {}),
    ("ultraviolet", "Ultraviolet",  285, 0.030, (0.66, 0.240, 292), 0.375, {}),
    ("clay",        "Clay",          40, 0.020, (0.70, 0.120,  35), 0.625, {}),

    # ---- the four named after design languages -------------------------------

    # Raw concrete and a safety-sign accent. Square corners, the darkest ground
    # here, and a border far brighter than anywhere else — structure is meant to
    # be SEEN. Thick rules are what it actually wants; width is not ours to set,
    # so the edge earns its presence through contrast instead.
    ("brutalism",   "Brutalism",     60, 0.004, (0.84, 0.190,  95), 0.0,
     dict(bg=0.1350, sidebar=0.1550, card=0.1900, popover=0.2200,
          border=0.5400, input=0.5000, fg=0.9900, muted=0.2400, hover=0.2900)),

    # The revival, not the original: neo-brutalism is a WEB style — flat black
    # outlines, saturated pop colours, no gradients, no rounding. Where
    # `brutalism` is concrete, this one is a sticker. The ground goes nearly
    # black and the border nearly white, because the look is really about a
    # hard outline around every box; width is not ours to set, so the edge is
    # pushed as far up the lightness ladder as it will go instead. The accent
    # is hot pink, and its label is black — that pairing IS the style.
    ("neo-brutalism", "Neo Brutalism", 320, 0.006, (0.7400, 0.2200, 350), 0.0,
     dict(bg=0.1200, sidebar=0.1400, card=0.1750, popover=0.2050,
          muted=0.2300, hover=0.2800, border=0.7500, input=0.6600, fg=0.9950)),

    # Soft UI: one material, lit gently, everything close together. The whole
    # look is extruded shadow, which a theme cannot set — so what carries it
    # here is the tight surface ladder and the big radius.
    #
    # Two places it is deliberately NOT faithful. Text contrast is not softened,
    # and the border is pulled up until it can actually be seen: the real style
    # hides its edges because the shadow draws them instead, and without the
    # shadow that leaves panels with no edge at all. The audit rejected the
    # honest value, and it was right to.
    ("neumorphism", "Neumorphism",  265, 0.012, (0.74, 0.090, 265), 1.0,
     dict(bg=0.2400, sidebar=0.2480, card=0.2620, popover=0.2800,
          border=0.3450, input=0.3900, fg=0.9500, muted=0.2820, hover=0.3100)),

    # Panes of lit glass over a cool ground. No blur available, so separation
    # does the work: surfaces step up further and faster than anywhere else, and
    # the neutrals carry real tint rather than a trace, the way glass takes the
    # colour of what is behind it.
    ("liquid-glass", "Liquid Glass", 235, 0.038, (0.78, 0.150, 225), 1.0,
     dict(bg=0.2000, sidebar=0.2320, card=0.2800, popover=0.3200,
          border=0.3900, input=0.4400, fg=0.9750, muted=0.3050, hover=0.3600)),

    # The admin-dashboard blue-violet: a desaturated ink-blue ground, a decisive
    # indigo, and restrained corners. The most ordinary theme here on purpose —
    # it is the one for looking at all day.
    ("metronic",    "Metronic",     268, 0.028, (0.58, 0.200, 285), 0.5,
     dict(bg=0.1900, sidebar=0.2080, card=0.2350, popover=0.2600,
          border=0.3050, input=0.3700)),
]


def usable_accent(l):
    """Keep the accent out of the band where no label reads well."""
    return WHITE_LABEL if WHITE_LABEL < l < DARK_LABEL else l


def ok(l, c, h):
    return f"oklch({l:.4f} {c:.4f} {h:.4f})"


def charts(al, ac, ah):
    """Five chart colours, two of which are not free choices: `--ok` and
    `--warn` are found BY HUE, so a theme with no green leaves "clean repo" to
    be invented from the accent instead."""
    return {
        "chart-1": ok(al, ac, ah),
        "chart-2": ok(min(al + 0.06, 0.88), ac * 0.85, (ah + 55) % 360),
        "chart-3": ok(0.7400, 0.1500, OK_HUE),
        "chart-4": ok(0.8000, 0.1400, WARN_HUE),
        "chart-5": ok(max(al - 0.08, 0.45), ac * 0.9, (ah + 300) % 360),
    }


def dark_block(bg_h, bg_c, accent, radius, over):
    """The block that actually gets used."""
    s = {**SURFACE, **over}
    al, ac, ah = accent
    al = usable_accent(al)
    # Neutrals carry a trace of the theme's hue. Without it the greys read as
    # some other theme's greys sitting behind this one's accent.
    n = lambda l, mult=1.0: ok(l, bg_c * mult, bg_h)

    # Text ON the accent fill. A theme's accent can be a pale gold, and white on
    # it is unreadable — so past a point the label goes dark instead.
    on_accent = ok(0.20, min(ac * 0.30, 0.04), ah) if al >= DARK_LABEL else ok(0.98, 0.005, ah)
    fg = n(s["fg"], 0.35)
    brand = ok(al, ac, ah)

    return {
        "background": n(s["bg"]),
        "foreground": fg,
        # Lighter than the background, always: the whole panel ladder in
        # `theme.ts` is built off this one.
        "card": n(s["card"]),
        "card-foreground": fg,
        "popover": n(s["popover"]),
        "popover-foreground": fg,
        "primary": brand,
        "primary-foreground": on_accent,
        "secondary": n(s["muted"]),
        "secondary-foreground": fg,
        "muted": n(s["muted"]),
        "muted-foreground": n(s["dim"], 0.6),
        # shadcn's `accent` is a quiet hover tint, NOT the brand colour —
        # `theme.ts` takes ours from `primary`. Kept faithful to their meaning.
        "accent": n(s["hover"]),
        "accent-foreground": n(min(s["fg"] + 0.015, 0.995), 0.35),
        "destructive": ok(0.6400, 0.2000, 25),
        "destructive-foreground": ok(0.9800, 0.0100, 25),
        "border": n(s["border"]),
        "input": n(s["input"]),
        "ring": brand,
        **charts(al, ac, ah),
        # Ours is the top bar and the sidebar, which is what theirs names too.
        "sidebar": n(s["sidebar"]),
        "sidebar-foreground": fg,
        "sidebar-primary": brand,
        "sidebar-primary-foreground": on_accent,
        "sidebar-accent": n(s["muted"]),
        "sidebar-accent-foreground": fg,
        "sidebar-border": n(s["border"]),
        "sidebar-ring": brand,
        "radius": f"{radius}rem",
    }


def light_block(bg_h, bg_c, accent, radius):
    """Never applied — the app is dark only. Written so the file has the shape
    of a real tweakcn export."""
    al, ac, ah = accent
    n = lambda l, mult=1.0: ok(l, bg_c * mult, bg_h)
    # Darkened for a white ground, where the dark block's lightness would be a
    # pastel with no contrast left.
    lal = max(usable_accent(al) - 0.18, 0.42)
    brand = ok(lal, ac, ah)

    return {
        "background": n(0.9900, 0.3),
        "foreground": n(0.1900, 0.5),
        "card": ok(1.0, 0, bg_h),
        "card-foreground": n(0.1900, 0.5),
        "popover": ok(1.0, 0, bg_h),
        "popover-foreground": n(0.1900, 0.5),
        "primary": brand,
        "primary-foreground": ok(0.9800, 0.0050, ah),
        "secondary": n(0.9600, 0.5),
        "secondary-foreground": n(0.2400, 0.5),
        "muted": n(0.9600, 0.5),
        "muted-foreground": n(0.5200, 0.8),
        "accent": n(0.9400, 0.8),
        "accent-foreground": n(0.2400, 0.5),
        "destructive": ok(0.5800, 0.2200, 25),
        "destructive-foreground": ok(0.9800, 0.0100, 25),
        "border": n(0.9000, 0.6),
        "input": n(0.9000, 0.6),
        "ring": brand,
        "chart-1": brand,
        "chart-2": ok(lal + 0.04, ac * 0.85, (ah + 55) % 360),
        "chart-3": ok(0.5800, 0.1500, OK_HUE),
        "chart-4": ok(0.6800, 0.1400, WARN_HUE),
        "chart-5": ok(max(lal - 0.06, 0.35), ac * 0.9, (ah + 300) % 360),
        "sidebar": n(0.9700, 0.4),
        "sidebar-foreground": n(0.1900, 0.5),
        "sidebar-primary": brand,
        "sidebar-primary-foreground": ok(0.9800, 0.0050, ah),
        "sidebar-accent": n(0.9400, 0.8),
        "sidebar-accent-foreground": n(0.2400, 0.5),
        "sidebar-border": n(0.9000, 0.6),
        "sidebar-ring": brand,
        "radius": f"{radius}rem",
    }


HEADER = """/* {name} — generated by scripts/generate_themes.py.
   NOT a tweakcn paste: change the spec in that script and re-run it rather than
   editing here, or the next run overwrites you.
   Only the `.dark` block is applied; `:root` is written for shape. */"""


def render(name, light, dark):
    def block(selector, tokens):
        lines = "\n".join(f"  --{k}: {v};" for k, v in tokens.items())
        return f"{selector} {{\n{lines}\n}}"

    return HEADER.format(name=name) + "\n" + block(":root", light) + "\n\n" + block(".dark", dark) + "\n"


def hue_gap(a, b):
    d = abs((a - b) % 360)
    return min(d, 360 - d)


def audit(dark):
    """The promises `theme.ts` relies on. A theme that breaks one still renders
    — it just renders wrong, quietly, which is the whole problem."""
    def parts(token):
        m = re.match(r"oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)", dark[token])
        return tuple(float(x) for x in m.groups())

    problems = []
    bg_l, card_l = parts("background")[0], parts("card")[0]
    side_l, fg_l = parts("sidebar")[0], parts("foreground")[0]

    if card_l <= bg_l:
        problems.append("card is not lighter than background")
    if not bg_l <= side_l <= card_l:
        problems.append("sidebar is not between background and card")
    if fg_l - bg_l < 0.55:
        problems.append(f"text sits only {fg_l - bg_l:.2f} off the background")
    if parts("border")[0] - bg_l < 0.08:
        problems.append("border is invisible against the background")

    found = [parts(f"chart-{i}") for i in range(1, 6)]
    for label, hue in (("ok", OK_HUE), ("warn", WARN_HUE)):
        if not any(c >= 0.05 and hue_gap(h, hue) <= 35 for _, c, h in found):
            problems.append(f"no chart colour for --{label}")

    al, fl = parts("primary")[0], parts("primary-foreground")[0]
    if abs(al - fl) < 0.35:
        problems.append(f"accent {al:.2f} against its label {fl:.2f} — too close")

    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="audit only, write nothing")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    failed = False

    for theme_id, name, bg_h, bg_c, accent, radius, over in SPECS:
        dark = dark_block(bg_h, bg_c, accent, radius, over)
        problems = audit(dark)
        if problems:
            failed = True
            for p in problems:
                print(f"  FAIL {theme_id}: {p}", file=sys.stderr)
        if not args.check:
            (OUT / f"{theme_id}.css").write_text(render(name, light_block(bg_h, bg_c, accent, radius), dark))

    verb = "audited" if args.check else f"written to {OUT.relative_to(OUT.parents[4])}"
    print(f"{len(SPECS)} themes {verb}" + ("" if failed else " — all pass"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
