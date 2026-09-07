# homely

Clean-room TypeScript clone of the Sweet Home 3D planner, built with Tauri v2.
Ticket **B1 (homely-scaffold)** delivered the application shell: build toolchain,
Tauri desktop window, a pure core state store seeded with the exact SH3D
empty-home defaults, the storage adapter seam, and the automation WebSocket
client that lets an external orchestrator drive the app.

Ticket **B2 (homely-core)** completes the core domain layer: full typed model
per `docs/schema/home-project.schema.json` (walls, rooms, furniture, levels,
dimension lines, labels, selection, cameras, compass, environment), an
undoable mutation API in `src/core/model.ts`, snapshot undo/redo with live
capability flags, and a deterministic wire serializer in `src/core/export.ts`
(half-even rounding to 3 decimals, angles normalized to (-180°, 180°]).

## Prerequisites

- Node.js >= 22 (developed on v24) and npm
- Rust stable (`rustup`)
- Linux system packages for Tauri v2 / WebKitGTK:

  ```sh
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev libdbus-1-dev libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev build-essential pkg-config
  ```

## Quickstart

```sh
npm install
npm run dev        # Vite dev server only (http://localhost:1420)
npm run tauri dev  # full desktop window on Linux/X11
```

Other scripts:

| Script             | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `npm run build`    | Type-checks (strict) then bundles to `dist/`              |
| `npm test`         | Vitest suite (protocol handshake, empty-home schema)      |
| `npm run smoke`    | End-to-end handshake against a local mock orchestrator    |
| `npm run lint`     | ESLint (flat config, typescript-eslint)                   |
| `npm run format`   | Prettier write                                            |
| `cargo check`      | Rust side compile check (run inside `src-tauri/`)         |

Smoke script options: `npm run smoke -- --port 8990` pins the mock
orchestrator port instead of using an ephemeral one.

## Automation protocol (v1)

The adapter connects **out** to the orchestrator, which is the WebSocket
server. The port comes from the URL query parameter `?automationPort=` in dev,
and will come from env var `HOMELY_AUTOMATION_PORT` once wired into Tauri
(later ticket). Frames are newline-delimited JSON.

- First message after connect: `{"type":"hello","app":"homely","version":1,"mode":"..."}`
- Requests: `{"id":"...","type":"...","params":{...}}` answered by exactly one
  `{"id":"...","ok":true,"data":{...}}` or `{"id":"...","ok":false,"error":"...","code":"..."}`
- Implemented in B1: `ping`, `new_home`, `get_state`, `get_capabilities`;
  B2 adds `add_furniture` (returns `{id}`), `undo`, `redo`
- Invalid parameters answer `INVALID_PARAMS`; unknown commands `UNKNOWN_COMMAND`

The authoritative contract is `../docs/specs/ws-protocol.md`. The export
serializer (`src/core/export.ts`) produces the wire form of `get_state`: it is
byte-identical across repeated calls for the same state, rounds lengths to 3
decimals (half-even), normalizes degree angles to (-180, 180], and passes
radian fields (`arcExtent`, latitude/longitude) through untouched. The test
suite validates both an empty home and a fully populated fixture against
`../docs/schema/home-project.schema.json` with ajv (draft 2020-12).

## Layout

```
src/
  core/            Pure state: home model + store (zero platform imports)
  services/        Storage/auth seams; adapters/ holds platform impls
  automation/      WS client, command handler, protocol version constant
  dev/             Mock orchestrator used by tests + smoke script
src-tauri/         Tauri v2 shell (window, icons, capabilities)
tests/             Vitest suites
scripts/           smoke-automation.ts entry point
```

## Empty-home defaults

`createEmptyHome()` in `src/core/home.ts` reproduces a freshly created SH3D 7.5
home exactly (verified against reference source `Home.java`, `Compass.java`,
camera defaults):

- `levels: []` — SH3D creates levels on demand; walls work with `levelRef: null`
- top camera `(50, 1050, 1010)`, yaw 180°, pitch 45°, fov 63°, lens PINHOLE
- observer camera `(50, 50, 170)`, yaw 315°, pitch 11.25°, fov 63°, lens PINHOLE

Note on the observer yaw: SH3D stores 315° and that is what `createEmptyHome()`
holds in memory. The wire export normalizes degree angles to (-180, 180], so
`get_state` reports it as `-45`. Both encode the same direction; tests assert
the wire form.
- compass at `(-100, 50)` diameter 100, north 0°, visible, lat/lon 0
- environment sky `#CCE4FC`, ground `#A8A8A8`, light `#D0D0D0`, wallsAlpha 1
- default wall height 250 cm; undo/redo empty

## Core model (B2)

- `src/core/home.ts` — types mirroring the schema + `createEmptyHome()`
- `src/core/store.ts` — snapshot undo/redo (cap 100), creation-ordered opaque
  ids (`wall-1`, `furniture-2`, …), `getHome()` stamps live
  `canUndo`/`canRedo` onto a deep clone; callers can never mutate store state
- `src/core/model.ts` — `HomeModel` facade: every operation is exactly one
  undo step, defaults are materialized on create, invalid input throws
  `ModelError` (surfaced as `INVALID_PARAMS` over the wire); removing a level
  nulls dangling `levelRef`s; selection ids must exist
- `src/core/export.ts` — deterministic serializer described above

## Legal note

No Sweet Home 3D code or assets are copied. Behaviour is re-implemented from
observation of the read-only GPL reference source under `sweethome3d-7.5-wayland-patch/`;
this package must never import from it.
