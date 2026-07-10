#!/usr/bin/env python3
"""Build the octiq-flow raster logo system from a transparent generated source."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
# The full brand set lives OUTSIDE src/. Everything under src/ is `frontendDist`
# and gets embedded verbatim into the app binary, so shipping the logo lockups,
# previews and every icon size cost ~1.4MB of binary for files the app never
# loads (card 20).
BRAND = ROOT / "brand"
SOURCE = BRAND / "source" / "octiq-flow-generated-source.png"

# The only brand files the running app loads (index.html: favicon, apple-touch
# icon, and the in-app header mark). These are copied into src/ so the binary
# carries just these three.
APP_ICONS = ROOT / "src" / "assets" / "brand" / "app-icons"
APP_ICON_SIZES = (32, 64, 256)

CYAN = (44, 197, 217)
BLUE = (88, 166, 255)
AMBER = (255, 190, 61)
NAVY = (11, 31, 58)
WHITE = (255, 255, 255)
DARK_BG = (13, 17, 23)
LIGHT_BG = (246, 248, 250)


def font(size: int, bold: bool = False):
    path = (
        "/System/Library/Fonts/Avenir Next.ttc"
        if bold
        else "/System/Library/Fonts/Avenir.ttc"
    )
    try:
        return ImageFont.truetype(path, size=size, index=5 if bold else 1)
    except OSError:
        return ImageFont.load_default(size=size)


def flatten_colors(image: Image.Image) -> Image.Image:
    """Map generated shading to four exact brand colors while retaining alpha."""
    rgba = image.convert("RGBA")
    smoothed = rgba.convert("RGB").filter(ImageFilter.GaussianBlur(radius=18))
    out = Image.new("RGBA", rgba.size)
    source = rgba.load()
    color_source = smoothed.load()
    target = out.load()

    for y in range(rgba.height):
        for x in range(rgba.width):
            _, _, _, alpha = source[x, y]
            if alpha == 0:
                target[x, y] = (0, 0, 0, 0)
                continue

            red, green, blue = color_source[x, y]
            # Amber is the only warm family. Cool pixels separate into cyan,
            # blue, and navy by brightness and blue dominance.
            if red > blue * 1.28 and green > blue * 0.72:
                color = AMBER
            elif max(red, green, blue) < 130:
                color = NAVY
            elif green > blue * 0.88:
                color = CYAN
            else:
                color = BLUE
            target[x, y] = (*color, alpha)
    alpha = out.getchannel("A")
    # Remove small classification islands inherited from generated texture.
    out = out.filter(ImageFilter.MedianFilter(size=9))
    out.putalpha(alpha)
    return out


def crop_and_square(image: Image.Image, size: int = 1024, padding: int = 72):
    alpha = image.getchannel("A")
    box = alpha.getbbox()
    if not box:
        raise ValueError("Source logo has no visible pixels")
    cropped = image.crop(box)
    available = size - padding * 2
    cropped.thumbnail((available, available), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - cropped.width) // 2
    y = (size - cropped.height) // 2
    canvas.alpha_composite(cropped, (x, y))
    return canvas


def recolor(image: Image.Image, rgb):
    solid = Image.new("RGBA", image.size, (*rgb, 255))
    solid.putalpha(image.getchannel("A"))
    return solid


def save_scaled(image: Image.Image, path: Path, size: tuple[int, int]):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.resize(size, Image.Resampling.LANCZOS).save(path, optimize=True)


def wordmark(color, height=220):
    label = "octiq-flow"
    face = font(126, bold=True)
    box = face.getbbox(label)
    width = box[2] - box[0]
    canvas = Image.new("RGBA", (width + 24, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.text((12, (height - (box[3] - box[1])) // 2 - box[1]), label, font=face, fill=(*color, 255))
    return canvas


def horizontal_lockup(mark, text_color):
    symbol = mark.resize((300, 300), Image.Resampling.LANCZOS)
    text = wordmark(text_color, 300)
    canvas = Image.new("RGBA", (symbol.width + 44 + text.width, 300), (0, 0, 0, 0))
    canvas.alpha_composite(symbol, (0, 0))
    canvas.alpha_composite(text, (symbol.width + 44, 0))
    return canvas


def stacked_lockup(mark, text_color):
    symbol = mark.resize((420, 420), Image.Resampling.LANCZOS)
    text = wordmark(text_color, 170)
    width = max(symbol.width, text.width)
    canvas = Image.new("RGBA", (width, 610), (0, 0, 0, 0))
    canvas.alpha_composite(symbol, ((width - symbol.width) // 2, 0))
    canvas.alpha_composite(text, ((width - text.width) // 2, 430))
    return canvas


def preview(lockup, background, path):
    canvas = Image.new("RGB", (1600, 900), background)
    scaled = lockup.copy()
    scaled.thumbnail((1180, 460), Image.Resampling.LANCZOS)
    x = (canvas.width - scaled.width) // 2
    y = (canvas.height - scaled.height) // 2
    canvas.paste(scaled, (x, y), scaled)
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, quality=94)


def main():
    if not SOURCE.exists():
        raise FileNotFoundError(f"Missing transparent source: {SOURCE}")

    BRAND.mkdir(parents=True, exist_ok=True)
    master = crop_and_square(flatten_colors(Image.open(SOURCE)))
    master.save(BRAND / "octiq-flow-mark-color.png", optimize=True)

    white = recolor(master, WHITE)
    navy = recolor(master, NAVY)
    white.save(BRAND / "octiq-flow-mark-white.png", optimize=True)
    navy.save(BRAND / "octiq-flow-mark-navy.png", optimize=True)

    horizontal_dark = horizontal_lockup(master, WHITE)
    horizontal_light = horizontal_lockup(master, NAVY)
    stacked_dark = stacked_lockup(master, WHITE)
    stacked_light = stacked_lockup(master, NAVY)
    horizontal_dark.save(BRAND / "octiq-flow-horizontal-dark.png", optimize=True)
    horizontal_light.save(BRAND / "octiq-flow-horizontal-light.png", optimize=True)
    stacked_dark.save(BRAND / "octiq-flow-stacked-dark.png", optimize=True)
    stacked_light.save(BRAND / "octiq-flow-stacked-light.png", optimize=True)

    for size in (16, 32, 48, 64, 128, 256, 512, 1024):
        save_scaled(
            master,
            BRAND / "app-icons" / f"octiq-flow-{size}.png",
            (size, size),
        )

    master.save(
        BRAND / "app-icons" / "octiq-flow.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    preview(horizontal_dark, DARK_BG, BRAND / "previews" / "logo-on-dark.jpg")
    preview(horizontal_light, LIGHT_BG, BRAND / "previews" / "logo-on-light.jpg")

    # Mirror only the icons index.html actually references into the frontend dir,
    # so a regenerated logo reaches the app without dragging the rest of the
    # brand set into the binary.
    APP_ICONS.mkdir(parents=True, exist_ok=True)
    for size in APP_ICON_SIZES:
        save_scaled(master, APP_ICONS / f"octiq-flow-{size}.png", (size, size))


if __name__ == "__main__":
    main()
