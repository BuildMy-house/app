# Releasing Homely

This project ships native installers built by **Tauri 2** (already integrated
in `homely/src-tauri/`) plus **Flatpak** and **Snap** packaging for Linux
app stores. Everything is produced automatically by GitHub Actions on a
version tag.

## Prerequisites (one-time)

1. **GitHub remote is configured** (`github.com/NaharEmet/homely.git`) and CI
   runs on every push. Pushing `v*` tags triggers the release pipelines.
2. **Pick a license.** A `LICENSE` (MIT) is committed; Flathub and the Snap
   Store both require one. Swap it if you prefer another license, and update
   the `license:` / `*_license` fields in the packaging files.
3. **Flathub / Snap store accounts** — needed only for the manual submission
   steps below; the CI build artifacts work without them.

## Cutting a beta/pre-release first

For Hermees-initiated changes, **always** cut a beta pre-release before going
straight to a stable tag:

```bash
./scripts/bump-version.sh 0.2.0          # version arg is always bare X.Y.Z
#   then update flatpak metainfo as usual
git add -A && git commit -m "v0.2.0-beta.1"
git tag v0.2.0-beta.1                    # suffix = -beta.N (or -rc.N)
git push origin v0.2.0-beta.1
```

Pushing the tag builds native installers and creates a GitHub Release marked
**Pre-release** (the workflow detects `-beta.` / `-rc.` in the tag name).
Once published, have testers and the equivalence harness exercise it:

```bash
cd equivalence && uv run pytest -q
```

Let the beta soak for a defined period. When satisfied, cut the real stable tag:

```bash
git tag v0.2.0                           # bare X.Y.Z = stable
git push origin v0.2.0
```

Never go straight from a merge to a stable tag for a Hermees-initiated change.

## Cutting a release

```bash
./scripts/bump-version.sh 0.2.0        # bump version in all packaging files
#   then edit flatpak/...metainfo.xml: add <release version="0.2.0" date="..."/>
git add -A && git commit -m "v0.2.0"
git tag v0.2.0
git push origin main --tags            # or: git push origin v0.2.0
```

Pushing the tag starts three workflows (see `.github/workflows/`):

| Workflow   | Runs on tag | Produces |
|------------|-------------|----------|
| `release.yml`  | `v*` | GitHub Release draft with `Homely…dmg`, `…Setup.exe` + `.msi`, `…AppImage` + `.deb` |
| `flatpak.yml`  | `v*` | `homely.flatpak` artifact (sideload / test) |
| `snap.yml`     | `v*` | `homely_*.snap` artifact |

`release.yml` creates a **draft** release so you can review before publishing.
Open the draft in the GitHub UI and click **Publish** when ready. To auto-publish
instead, set `releaseDraft: false` in `release.yml`.

## Install notes (unsigned builds)

CI signs nothing yet (decision: ship unsigned first). Users see warnings:

- **macOS** — Gatekeeper blocks the unidentified app. After copying to
  Applications: `xattr -cr /Applications/Homely.app` (or right-click → Open).
- **Windows** — SmartScreen warns "unrecognized publisher"; click
  *More info → Run anyway*.

To remove the warnings later, add Apple Developer ID + Windows Authenticode
certs as repo secrets and wire signing into `release.yml` (no app-code change).

## Getting into the COSMIC Shop

The COSMIC Store aggregates **Flathub** and distro repos, so the path to "easy
install" for COSMIC / Pop!_OS users is a Flathub listing. (The `.deb` from the
GitHub Release also installs via COSMIC Store directly, but won't appear in the
catalog.)

1. Fork `https://github.com/flathub/flathub`.
2. Create a repo `com.house-designer.homely` under your fork containing the
   manifest `flatpak/com.house-designer.homely.yaml`. (Update the homepage URL
   in the metainfo first.)
3. Open a PR against the `new-pr` branch titled `Add com.house-designer.homely`.
4. After review/merge it builds on Flathub and shows up in the COSMIC Store
   (and everywhere Flathub is enabled).

You can test the manifest locally before submitting with
`flatpak-builder --repo=repo flatpak/com.house-designer.homely.yaml` or by
installing the `homely.flatpak` CI artifact (`flatpak install --bundle homely.flatpak`).

## Publishing to the Snap Store

1. Install `snapcraft` locally (or use the `homely_*.snap` CI artifact).
2. Log in once: `snapcraft login`.
3. Register the name (if not taken): `snapcraft register homely`.
4. Upload + release: `snapcraft upload homely_*.snap --release=stable`.

To automate publishing later, add `SNAPCRAFT_STORE_CREDENTIALS` (from
`snapcraft export-login --snap=homely -`) as a repo secret and add a
`snapcore/action-publish` step to `snap.yml`.

## Notes

- Builds are offline-safe: the frontend assets/models are generated locally by
  `npm run build` (no network fetch at runtime).
- macOS binaries are **universal** (Intel + Apple Silicon) from one runner to
  keep CI minutes down.
- Versions must match across `package.json`, `tauri.conf.json`, `Cargo.toml`,
  `snapcraft.yaml`, and the metainfo `<release>` — `bump-version.sh` handles
  the first four.
