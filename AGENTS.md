# Repository Instructions

## Versioning

Every commit increments the patch version by one (`0.1.0` → `0.1.1`). The
single source of truth is `src-tauri/Cargo.toml`; update it and let Cargo refresh
the `octiq-flow` entry in `src-tauri/Cargo.lock`. The web build reads the Cargo
version automatically, so do not mirror the release version in
`web/package.json`.
