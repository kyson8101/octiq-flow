# npm installation

OctiqFlow ships as one small JavaScript launcher plus one native optional
dependency selected by npm for the current operating system and CPU.

```bash
npx octiqflow
```

No Rust compiler, pnpm installation, or source checkout is required. The native
package contains `octiq-server` and the built browser client at `bin/v2`, which
is one of the runtime locations already understood by `web.rs`.

## Packages

| Package | Host |
| --- | --- |
| `octiqflow` | JavaScript CLI and platform selection |
| `octiqflow-darwin-arm64` | Apple silicon macOS runtime |
| `octiqflow-darwin-x64` | Intel macOS runtime |
| `octiqflow-linux-x64` | x64 Linux runtime |
| `octiqflow-win32-x64` | x64 Windows runtime |

The source manifests use `0.0.0-development`. `src-tauri/Cargo.toml` remains the
single version source: `scripts/package-npm.mjs` reads it and stamps all staged
packages with the same version immediately before publication.

## Commands

- `octiqflow` runs the server in the foreground on every supported host.
- `octiqflow install` copies the selected runtime under
  `~/.octiqflow/runtimes/<version>` and installs a macOS launchd user service.
- `octiqflow status`, `restart`, `open`, and `uninstall` manage that service.
- Uninstalling the service does not delete profiles or transcripts.

Service installation is intentionally a command, not an npm lifecycle hook.
Installing a dependency must not silently start a machine-level background
process.

## Publishing

`.github/workflows/npm-release.yml` builds all four native packages, verifies
their contents, publishes them first, and publishes the CLI last. A `vX.Y.Z`
tag must exactly match the Cargo version. The repository needs an npm
`NPM_TOKEN` secret with publish access to all five packages. A manual workflow
run builds and verifies packages without publishing unless its `publish` input
is explicitly enabled.
