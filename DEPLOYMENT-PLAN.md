# Deployment & Infrastructure Plan — companyd + Autonomous Generations

This plan describes the infrastructure needed for Hermees and Engineering to autonomously deploy themselves while maintaining safety, auditability, and the ability to recover from failures.

## Architecture: companyd

**companyd** is a host-level daemon (runs via systemd) that manages independent deployment generations for both Hermees and Engineering containers. It keeps deployments out of application code and maintains separation of concerns:

- **Application logic:** Hermees decides what to do, Engineering builds it
- **Deployment logic:** companyd handles safety, routing, and recovery
- **Host supervisor:** companyd never makes company decisions, only ensures durable state matches desired state

### Key Concepts

**Generations:** Each component (Hermees, Engineering) has independently versioned instances.

```
H17 (Hermees generation 17)     — ACTIVE
H16                             — rolled back candidate

E42 (Engineering generation 42)  — ACTIVE  
E41                             — rolled back candidate
```

Hermees and Engineering update independently:
```
H17 + E42
H17 + E43   (only Engineering updated)
H18 + E43   (both updated, but separately)
```

**Generation Lifecycle:**

```
BUILDING     → STARTING      → WARMING       → TESTING
    ↓            ↓               ↓              ↓
docker build  container       health checks   synthetic
              starts          log verification tests

    ↓            ↓               ↓              ↓
READY        → ACTIVE        → DRAINING      → RETIRED
    ↓            ↓               ↓              ↓
passed        all new work    finish existing  stop & cleanup
tests         goes here       tasks (30 min max)
```

Failure states: `BUILD_FAILED`, `TEST_FAILED`, `ACTIVATION_FAILED`, `DRAIN_TIMEOUT`, `FAILED`, `ROLLED_BACK`

## Deployment Flow — Engineering

```
E42 ACTIVE
    ↓
Engineering creates new code, commits abc123
    ↓
requests: deploy_engineering(git_sha=abc123)
    ↓
companyd.build(engineering, abc123)
    ├─ checkout commit
    ├─ docker build → engineering:E43
    └─ tag with generation number
    ↓
E43 = BUILDING → passes → STARTING
    ↓
companyd.start(E43, MODE=WARMING)
    ├─ run container with GENERATION=E43
    ├─ container cannot accept new work (WARMING)
    ├─ has read access to durable state
    └─ E42 remains ACTIVE
    ↓
companyd.test(E43)
    ├─ health check (process alive, port responding)
    ├─ synthetic self-test:
    │  ├─ create test repo
    │  ├─ spawn worker via engineering-manager
    │  ├─ worker creates deployment-test.txt
    │  ├─ run tests
    │  ├─ verify git works
    │  └─ destroy test workspace
    ├─ state reconciliation:
    │  ├─ inspect current engineering tasks
    │  ├─ inspect repos and branches
    │  ├─ verify database connectivity
    │  └─ report readiness
    └─ if all pass → E43 = READY
    ↓
companyd.activate(E43)
    ├─ atomic: active_engineering_generation = E42 → E43
    ├─ E43 = ACTIVE
    ├─ E42 = DRAINING
    └─ new work goes to E43, existing tasks stay with E42
    ↓
companyd.drain(E42, max_duration=30m)
    ├─ E42 stops accepting new work
    ├─ E42's existing tasks continue to completion
    ├─ tasks are pinned to worktrees on host:
    │  ├─ /company/worktrees/task-172/
    │  ├─ /company/worktrees/task-173/
    │  └─ file-level locks prevent concurrent modification
    │
    ├─ if all tasks finish before deadline:
    │  └─ E42 = RETIRED, container stops
    │
    └─ at deadline (30 min):
        ├─ companyd.checkpoint(E42)
        │  ├─ for each active task:
        │  │  ├─ persist task state (branch, commit, stage)
        │  │  ├─ persist working files
        │  │  ├─ persist last agent summary
        │  │  └─ mark task as INTERRUPTED
        │  └─ store checkpoint in Company PG
        │
        ├─ stop E42 container
        ├─ E43 recovers interrupted tasks:
        │  ├─ fetch checkpoint from Company PG
        │  ├─ restore worktree to last good state
        │  └─ dispatch recovery prompt to manager
        │
        └─ E42 = RETIRED
```

## Deployment Flow — Hermees

```
H17 ACTIVE
    ↓
Engineering builds new Hermees version, commits d821ab
    ↓
requests: deploy_hermees(git_sha=d821ab)
    ↓
companyd.build(hermees, d821ab)
    └─ hermees:H18
    ↓
companyd.start(H18, MODE=WARMING)
    ├─ load company state (projects, engineering state, decisions, etc.)
    ├─ H17 remains ACTIVE
    ├─ H18 = WARMING
    ↓
companyd.test(H18)
    ├─ health check
    ├─ load company state reconciliation:
    │  ├─ active projects
    │  ├─ current engineering generation
    │  ├─ pending engineering tasks
    │  ├─ pending human requests
    │  ├─ open decisions
    │  ├─ open incidents
    │  ├─ budgets and limits
    │  └─ report HANDOVER_ACCEPTED or HANDOVER_FAILED
    └─ H18 = READY
    ↓
companyd.activate(H18)
    ├─ atomic: active_hermees_generation = H17 → H18
    ├─ H18 = ACTIVE
    ├─ H17 = DRAINING
    ↓
companyd.drain(H17, max_duration=30m)
    ├─ H17 finishes current message/decision
    ├─ typically drains much faster than Engineering
    └─ H17 = RETIRED
```

## Durable State (Outside Containers)

**Hybrid model:** Company PG holds audit trail, local `/company/` directory holds active generation pointers.

```
/company/
  ├── runtime-control.json                 ← atomic active generation pointers (companyd reads/writes this)
  │   {
  │     "hermees": { "generation": "H18", "updated_at": "2026-09-09T14:22:00Z" },
  │     "engineering": { "generation": "E43", "updated_at": "2026-09-09T14:22:00Z" }
  │   }
  │
  ├── postgres/                            Company PG + Observer PG databases
  ├── repos/
  │   ├── buildmyhouse/
  │   ├── website/
  │   ├── hermees/
  │   ├── observer-website/
  │   └── company-os/
  ├── worktrees/                           Task-specific git worktrees
  │   ├── task-172/
  │   ├── task-173/
  │   └── ...
  ├── logs/
  │   ├── companyd.log
  │   ├── hermees-H17.log
  │   ├── hermees-H18.log
  │   ├── engineering-E42.log
  │   └── engineering-E43.log
  └── secrets/
      └── (Infisical will inject these at startup)
```

**Company PG schema:**
```sql
deployments table  ← full audit trail (every build, test, activation, drain event)
```

Mount relevant paths into containers:

```
Engineering E43:
  /company/repos → /workspace/ (read)
  /company/worktrees → /company/worktrees (read/write with file locks)
  ~/.config/ai-cli → /root/.config/ai-cli (read)

Hermees H18:
  /company/postgres (connection only, no mount)
  /company/logs → /logs (write)
```

## companyd Interface

**companyd is an MCP server** (Model Context Protocol). Hermees and Engineering call companyd through MCP tools, not direct CLI or HTTP.

### MCP Tools

```
companyd.get_status(component)
  → {generation, status, active_tasks, drain_progress}

companyd.deploy(component, git_sha, reason)
  → {deployment_id, status, ...}

companyd.get_deployment_status(deployment_id)
  → {component, generation, status, build_log, test_log, ...}

companyd.rollback(component, reason)
  → {deployment_id, previous_generation, status, ...}

companyd.list_generations(component)
  → [{generation, status, created_at, activated_at, retired_at}]

companyd.get_metrics()
  → {deployments_total, auto_rollbacks, avg_drain_duration, failures}
```

**Security:**
- MCP authenticated via API key (shared secret)
- Requests must originate from localhost (local network only)
- Key passed via environment variable or .env

**Crash Recovery:**
1. companyd runs via systemd with auto-restart (5-second backoff)
2. On startup, companyd reads `/company/runtime-control.json`
3. Verifies active generation containers still exist (`docker ps`)
4. If container alive: resume normally
5. If container dead but marked active: log incident, return error state
6. If companyd crashed mid-deployment: resume from checkpoint or rollback previous
7. Reports recovery status to Hermees via metrics endpoint

---

## companyd Data Model

### Deployments Table

```sql
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  component TEXT,              -- 'hermees' or 'engineering'
  generation TEXT,             -- H18, E43
  git_sha TEXT,                -- commit hash
  docker_image TEXT,           -- hermees:H18, engineering:E43
  requested_by TEXT,           -- who requested (Engineering, Hermees, human)
  reason TEXT,                 -- why deployed
  status TEXT,                 -- BUILDING, STARTING, WARMING, TESTING, READY, ACTIVE, DRAINING, RETIRED, etc.
  
  created_at TIMESTAMP,
  build_start TIMESTAMP,
  build_end TIMESTAMP,
  test_start TIMESTAMP,
  test_end TIMESTAMP,
  activate_time TIMESTAMP,
  drain_start TIMESTAMP,
  drain_end TIMESTAMP,
  
  previous_generation TEXT,    -- rollback candidate
  rollback_required BOOLEAN,
  rollback_reason TEXT,
  
  tests_passed BOOLEAN,
  test_summary TEXT,
  self_test_passed BOOLEAN,
  health_check_passed BOOLEAN,
  
  active_tasks_at_drain INT,   -- how many tasks interrupted
  drain_duration_seconds INT,  -- actual drain time
  
  human_intervention_required BOOLEAN,
  notes TEXT
);
```

### Runtime Control

```sql
CREATE TABLE runtime_control (
  component TEXT PRIMARY KEY,  -- 'hermees', 'engineering'
  active_generation TEXT,      -- H17, E42 (what's currently running)
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

## Phases

### Phase 1: companyd Core (Weeks 1-2)

**T1.1: companyd Host Daemon**
- Systemd unit file (runs companyd on boot)
- State machine: generation lifecycle
- Atomic generation pointer updates
- Docker lifecycle management (build, start, stop, logs)
- Health check framework

**T1.2: Deployment Table & History**
- Schema for deployments table
- Recording each deployment (build, test, activate, drain events)
- Query interface for deployment history
- Rollback candidate tracking

**T1.3: Build Pipeline**
- companyd.build(component, git_sha)
- Checkout exact commit
- docker build with generation tagging
- Build error handling & rollback
- Image cleanup policy

**T1.4: Health Checks & Synthetic Tests**
- Health check framework (/health endpoint)
- Engineering self-test (synthetic task, verify end-to-end)
- Hermees handover reconciliation test
- Test timeout + failure handling

**Acceptance Criteria:**
- companyd starts via systemd
- Can build an image and tag it with generation
- Can run health checks on a container
- Deployment records persist
- State survives reboot

## Auto-Rollback Triggers

**Automatic rollback (no human intervention):**
- Test spin-up fails (container won't start)
- Health check fails consistently (5+ consecutive failures)
- Synthetic test fails (can't create test file, git broken, etc.)
- companyd crash recovery detects a dead active container

**Requested rollback (Hermees or Engineering requests it):**
- Either component can call `companyd.rollback(component, reason)`
- companyd rolls back to previous generation immediately
- Records reason in deployment history

**Manual rollback (human intervention):**
- User runs companyd CLI: `companyd-cli rollback <component>`
- Use only if auto-rollback doesn't work or for emergency recovery

### Phase 2: Generational Deployment (Weeks 2-3)

**T2.1: Engineering Deployment Orchestration**
- companyd.deploy(engineering, git_sha) wrapper
- BUILDING → STARTING → WARMING → TESTING → READY → ACTIVE → DRAINING → RETIRED sequence
- Atomic active-generation switch
- Handles failures at each step

**T2.2: Hermees Deployment Orchestration**
- companyd.deploy(hermees, git_sha)
- State reconciliation before handover
- HANDOVER_ACCEPTED check
- Shorter drain window

**T2.3: Drain & Task Checkpointing**
- Engineering tracks active tasks
- 30-minute maximum drain
- Task checkpoint schema (branch, commit, stage, files changed)
- Interrupted task persistence in Company PG
- E43 resumes interrupted tasks

**T2.4: Rollback**
- companyd.rollback(component)
- Keeps previous generation image
- Restores durable state
- Automatic rollback for infrastructure failures

**Acceptance Criteria:**
- Deploy new Engineering generation (blue/green handover)
- Drain with active tasks continuing
- Checkpoint unfinished work at deadline
- New generation resumes checkpointed tasks
- Rollback restores previous generation
- Deployment history recorded

### Phase 3: Container Integration (Weeks 3-4)

**T3.1: docker-compose for Multi-Generation**
- Hermees service (multiple versions)
- Engineering service (multiple versions)
- Durable volume mounts (/company/*)
- Environment variable injection
- Port mapping strategy

**T3.2: Reboot Recovery**
- companyd reads runtime_control on startup
- Restarts active generations
- Reconciles interrupted tasks
- Company resumes without manual intervention

**T3.3: Logging & Monitoring**
- companyd logs (startup, deployments, errors)
- Per-generation logs
- Simple dashboard (generation status, active tasks, drain progress)
- Deployment timeline view

**Acceptance Criteria:**
- docker-compose up starts active generations
- Reboot recovery works (stop containers, reboot, start companyd, containers restart)
- Logs show deployment sequence
- Dashboard shows current state

### Phase 4: Autonomy Integration (Weeks 4-5)

**T4.1: Deployment Requests from Hermees & Engineering**
- Engineering requests: deploy_engineering(git_sha)
- Hermees requests: deploy_hermees(git_sha)
- companyd validates & executes
- Deployment becomes autonomy data (who requested, why, outcome)

**T4.2: Deployment Observability**
- Every deployment recorded with:
  - Requested by (Engineering, Hermees, human)
  - Reason (CEO strategy, bug fix, experiment, etc.)
  - Success/failure
  - Drain duration
  - Tasks interrupted & recovered
  - Automatic rollbacks triggered
- Feeds into autonomy measurement

**T4.3: Compatibility Checks**
- Hermees specifies: requires engineering_protocol >= 3
- Engineering reports: engineering_protocol = 3
- companyd verifies before activation
- Prevents incompatible deployments

**Acceptance Criteria:**
- Hermees successfully deploys new version of itself
- Engineering successfully deploys new version of itself
- Engineering successfully deploys new Hermees
- Deployment events recorded as autonomy data
- Compatibility verified before activation

## Implementation Order

Build in this order:

1. **companyd core** — state machine, Docker lifecycle, atomic generation pointers
2. **Build + test pipeline** — docker build, health checks, synthetic tests
3. **Engineering deployment orchestration** — WARMING → ACTIVE → DRAINING → RETIRED
4. **Hermees deployment orchestration** — state reconciliation handover
5. **Task checkpointing & recovery** — persist interrupted work, resume on new generation
6. **docker-compose multi-generation** — volumes, env vars, port routing
7. **Reboot recovery** — companyd reconciles state on startup
8. **Logging & dashboard** — deployment history, generation status
9. **Autonomy integration** — deployment as experiment data, compatibility checks

## Expected Outcomes

✅ Hermees and Engineering deploy independently without downtime
✅ Failed deployments automatically rollback
✅ Interrupted work survives generation transitions
✅ Laptop survives reboot without manual intervention
✅ Deployment behavior is measured as autonomy data
✅ No complex container orchestration (companyd stays narrow)

## Integration with Earlier Phases

- **Phase 1 (Postgres):** Company PG stores deployment history & interrupted tasks
- **Phase 2 (Human Interface):** companyd can request human intervention if needed
- **Phase 9 (Testing/CI/CD):** companyd's synthetic tests validate each generation
- **Steward integration:** Deployment events logged to Steward memory
