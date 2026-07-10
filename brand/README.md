# octiq-flow logo assets

The mark represents three coordinated agent paths moving around a shared
orchestration hub. It is designed for the app's dark developer-tool UI and
remains recognizable at favicon size.

## Primary files

- `octiq-flow-mark-color.png` - 1024 x 1024 transparent master mark.
- `octiq-flow-mark-white.png` - monochrome mark for dark or photographic use.
- `octiq-flow-mark-navy.png` - monochrome mark for light backgrounds.
- `octiq-flow-horizontal-dark.png` - horizontal lockup with a light wordmark.
- `octiq-flow-horizontal-light.png` - horizontal lockup with a dark wordmark.
- `octiq-flow-stacked-dark.png` - stacked lockup with a light wordmark.
- `octiq-flow-stacked-light.png` - stacked lockup with a dark wordmark.
- `app-icons/` - transparent PNGs from 16 px through 1024 px, plus ICO.
- `previews/` - non-transparent presentation previews only.
- `source/` - background-removed Imagegen source used by the build script.

## Brand colors

- Cyan: `#2CC5D9`
- Blue: `#58A6FF`
- Amber: `#FFBE3D`
- Navy: `#0B1F3A`
- App background: `#0D1117`

## Usage

Keep clear space around the mark equal to roughly one node diameter. Use the
full-color mark whenever contrast allows. Use the white or navy monochrome
variant when color reproduction is limited. Do not rotate, stretch, add
shadows, recolor individual paths, or place the mark directly on a busy image.

The packaged icons in `src-tauri/icons/` are intentionally unchanged. Replace
them only after explicitly approving this identity for the application build.

Regenerate the complete raster set with:

```sh
python scripts/generate_brand_assets.py
```

The script requires Pillow.
