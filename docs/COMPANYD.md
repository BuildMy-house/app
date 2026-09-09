# COMPANYD.md — Architecture & Usage

## Overview

**companyd** is a host-level daemon that manages autonomous multi-generation
deployment for Hermees and Engineering containers. It keeps deployment logic
out of application code and handles safety, routing, and recovery.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  companyd (host daemon, runs via systemd)        │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ RuntimeControl│  │ StateManager             │  │
│  │ (atomic ptr)  │  │ (lifecycle orchestration)│  │
│  └──────┬───────┘  └──────────┬───────────────┘  │
│         │                     │                  │
│  ┌──────┴───────┐  ┌─────────┴──────────────┐   │
│  │ DockerLifecycle│  │ HealthCheck            │   │
│  │ (build/start/ │  │ SyntheticTests         │   │
│  │  stop/logs)   │  │ (validation)           │   │
│  └──────────────┘  └────────────────────────┘   │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ SystemdSocketListener (Unix domain socket) │  │
│  │ Commands: build, start, test, activate,    │  │
│  │           drain, status, logs              │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Generation Lifecycle

Each component (Hermees, Engineering) has independently versioned instances:

```
BUILDING → STARTING → WARMING → TESTING → READY → ACTIVE → DRAINING → RETIRED
```

Failure states: `BUILD_FAILED`, `TEST_FAILED`, `ACTIVATION_FAILED`,
`DRAIN_TIMEOUT`, `FAILED`, `ROLLED_BACK`.

## Installation

### Systemd

```bash
sudo cp company-ops/companyd/systemd/companyd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable companyd
sudo systemctl start companyd
```

### Verify

```bash
systemctl status companyd
journalctl -u companyd -f
```

## CLI Usage

```bash
# Show help and available socket commands
python3 company-ops/companyd/companyd.py --help

# Show version
python3 company-ops/companyd/companyd.py --version

# Run as daemon (logs to file)
python3 company-ops/companyd/companyd.py --daemon
```

## Socket Protocol

companyd listens on a Unix domain socket at `/var/run/companyd.sock`.
Clients send JSON requests and receive JSON responses.

### Request format

```json
{
  "command": "build",
  "args": {
    "component": "engineering",
    "git_sha": "abc123def"
  }
}
```

### Response format

```json
{
  "status": "success",
  "command": "build",
  "generation": "E43",
  "message": "Build started"
}
```

### Commands

| Command    | Description                             | Key args                                      |
|------------|-----------------------------------------|-----------------------------------------------|
| `build`    | Build a new generation image            | `component`, `git_sha`                        |
| `start`    | Start a generation container            | `generation`, `mode` (default: WARMING)       |
| `test`     | Run synthetic tests on a generation     | `generation`                                  |
| `activate` | Atomically switch active generation     | `generation`                                  |
| `drain`    | Drain an active generation              | `generation`, `max_duration` (default: 1800s) |
| `status`   | Get status of generation(s)             | `component` and/or `generation`               |
| `logs`     | Get recent container logs               | `generation`, `lines` (default: 100)          |

## Key Classes

### Generation

Represents a versioned instance (e.g., H17, E42). Tracks lifecycle state
with validated transitions.

### RuntimeControl

Atomic pointer to the active generation per component. Uses `fcntl.flock()`
for file-level locking to prevent races between concurrent processes.

### Deployment

Records deployment events for history and rollback. Stores timestamps,
test results, and rollback information.

### DockerLifecycle

Wraps docker CLI operations (`build`, `start`, `stop`, `logs`). Raises
`DockerError` on failures.

### HealthCheck

Validates running containers via HTTP `GET /health`. Returns status,
response time, and error details.

### SyntheticTests

- `engineering_self_test()`: simulates a small task dispatch
- `hermees_reconciliation()`: validates state coherence before handover

### StateManager

Orchestrates the generation lifecycle. Creates generations, manages
transitions, and persists deployment records.

## File Layout

```
/var/lib/companyd/
  └── runtime_control.json    # active generation pointers

/var/run/companyd.sock        # Unix domain socket

/var/log/companyd/
  └── companyd.log            # daemon logs
```

## Design Decisions

- **Single-file daemon** for Phase 1 simplicity; split into modules later
  if needed.
- **fcntl.flock()** for RuntimeControl atomicity — simpler than a database
  transaction for a single-host daemon.
- **Stub command handlers** in Phase 1 socket listener; full orchestration
  logic comes in Phase 2.
- **In-memory state** for Phase 1; T1.2 adds database persistence.
