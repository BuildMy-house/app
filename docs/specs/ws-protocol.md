# Homely Automation WebSocket Protocol v1

Status: **FROZEN for Wave 1** (changes require integrator approval via board note)

All three automation surfaces implement this exact protocol:

1. `sh3d-driver` (Java process, Track A) — TCP socket, newline-delimited JSON,
   identical envelope. Runs the real Sweet Home 3D UI and executes commands
   through its MVC controllers.
2. `homely` automation client (`homely/src/automation/client.ts`, Track B) —
   browser WebSocket client connecting OUT to the orchestrator.
3. `MockAdapter` (Track C) — pure Python reference implementation used to
   develop/verify the harness before real adapters land.

## Transport & framing

- URL: `ws://127.0.0.1:<port>` (driver: plain TCP with the same framing;
  one JSON object per line, UTF-8, `\n` terminated).
- Direction: adapters connect TO the orchestrator. Orchestrator is the server.
- Every message is a JSON object with a `type` field.
- Env/launch: driver gets `--port`; homely gets `HOMELY_AUTOMATION_PORT` env.

## Envelope

Request (orchestrator → adapter):

```json
{ "id": "req-17", "type": "click", "params": { "x": 100, "y": 100 } }
```

Response (adapter → orchestrator), exactly one per request:

```json
{ "id": "req-17", "ok": true, "data": {} }
{ "id": "req-18", "ok": false, "error": "no wall under point", "code": "NO_TARGET" }
```

Unsolicited messages allowed only from adapter: `{ "type": "hello", ... }`
on connect, then silence unless requested.

## Commands

Coordinates are **centimeters in plan/model space**; angles **degrees** unless
suffixed otherwise. All commands are idempotent unless noted.

### Lifecycle
| type | params | data | notes |
|---|---|---|---|
| `hello` | — (adapter→orchestrator only) | `{app:"sh3d-driver"|"homely", version, mode}` | first message after connect |
| `ping` | — | `{pong:true}` | liveness |
| `new_home` | — | `{}` | resets to empty home, clears undo stack |
| `open` | `{path}` | `{}` | load project file |
| `save` | `{path}` | `{}` | write project file |

### Tools & interaction
| type | params | data |
|---|---|---|
| `select_tool` | `{tool:"selection"\|"panning"\|"wall"\|"room"\|"polyline"\|"dimensionLine"\|"label"}` | `{}` |
| `move_mouse` | `{x,y}` | `{}` |
| `click` | `{x,y,dbl?:bool,shift?:bool,altOrMeta?:bool}` | `{}` | press+release at same point; `dbl`=double-click |
| `drag` | `{fromX,fromY,toX,toY,shift?,altOrMeta?}` | `{}` | move→press→move(to)→release |
| `key` | `{key:"escape"\|"delete"\|"backspace"}` | `{}` |
| `set_magnetism` | `{enabled:bool}` | `{}` | explicit; do NOT rely on modifier keys |

### Editing actions (map to SH3D ActionType / clone commands)
| type | params | data |
|---|---|---|
| `undo` / `redo` | — | `{canUndo,canRedo}` post-state |
| `delete_selection` | — | `{}` |
| `copy` / `paste` / `duplicate` | — | `{}` |
| `select_all` | — | `{}` |
| `clear_selection` | — | `{}` |
| `select_object` | `{objectId}` | `{}` | by state-export id when available |
| `modify_selected` | `{props:{angleDeg?,x?,y?,width?,depth?,height?,elevation?,thickness?,...}}` | `{}` | opens-equivalent of modify dialog applied programmatically |

### Furniture
| type | params | data |
|---|---|---|
| `add_furniture` | `{catalogId,x,y,angleDeg?}` | `{objectId}` | catalogId from catalogue manifest; driver resolves via SH3D catalog, homely via its own manifest |
| `list_catalog` | — | `{items:[{catalogId,name,width,depth,height,doorOrWindow}]}` |

Furniture items may carry an optional `textureId` field (string or null) referencing a material texture from the shared texture catalog (same ids as wall textures). When present, the 3D renderer applies the referenced texture as the piece's surface material instead of its flat `color`.

### View / camera
| type | params | data |
|---|---|---|
| `zoom` | `{factor}` | `{scale}` |
| `set_view` | `{view:"plan"\|"3d"}` | `{}` |
| `set_camera` | `{x,y,z,yawDeg,pitchDeg,fovDeg}` | `{}` | applies to active 3D camera |
| `camera_preset` | `{preset:"top"\|"observer"}` | `{camera:{...}}` | returns resulting camera state |

### Introspection & capture
| type | params | data |
|---|---|---|
| `get_state` | — | NormalizedHomeState JSON conforming to `docs/schema/home-project.schema.json` (schemaVersion 1) |
| `screenshot` | `{view:"plan"\|"3d", width:int, height:int}` | `{pngBase64, width, height}` | OFFSCREEN canvas render only — no window chrome, no fonts from chrome, DPR=1, no animations. Deterministic given same home + camera + size. |
| `get_capabilities` | — | `{commands:[...]}` |

## Determinism requirements (both apps)

- Screenshot: fixed clear colors, no time-based animation, AA on but
  deterministic (no temporal AA), DPR forced to 1.
- State export rounding: lengths/angles rounded half-even to 3 decimals.
- IDs are opaque strings; cross-app correspondence is handled by the
  harness creation-order ledger, never by matching raw ids.
