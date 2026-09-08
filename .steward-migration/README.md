# Steward Migration: Homely to Dedicated Instance

## Overview

This directory contains exported data from the global Steward ACS instance
that should be imported into the new Homely-specific Steward at:
`https://homely.stewardacs.xyz/mcp/coding/sse`

## Files

| File | Contents |
|------|----------|
| `memories.json` | 30 homely-related memories (learnings, patterns, warnings, invariants) |
| `specs.json` | 11 homely-related specs (automation, core, plan, view3d, equivalence) |
| `skills.json` | 2 homely-related skills (hermes-engineering-setup, sh3d-driver-run) |

## Import Instructions

### Prerequisites

1. Ensure the new Steward instance is running at `https://homely.stewardacs.xyz`
2. Have a valid API key for the new instance
3. Run opencode from the repo root (`/home/nahar/Documents/code/house_designer/`) — the root `opencode.json` is already configured for the new Steward

### Step 1: Import Memories

For each memory in `memories.json`, call `steward_save_memory`:

```
steward_save_memory(
  kind: <kind>,
  title: <title>,
  content: <content>,
  scope_path: <scope_path>,
  visibility: <visibility>,
  importance: <importance>,
  status: "approved"
)
```

### Step 2: Import Specs

For each spec in `specs.json`, call `steward_specs_propose`:

```
steward_specs_propose(
  app: <app>,
  path: <path>,
  purpose: <purpose>,
  title: <title>
)
```

### Step 3: Import Skills

For each skill in `skills.json`, call `steward_skill_save`:

```
steward_skill_save(
  name: <name>,
  content: <full markdown content>,
  description: <description>,
  tags: <tags>,
  scope_paths: <scope_paths>,
  when_to_use: <when_to_use>
)
```

Note: The skill `content` field requires the full markdown body. These are
not stored in the export — you'll need to reconstruct or re-create them
from the source repo files.

## Post-Import

1. Verify the data appears in the new Steward's governance UI
2. Approve any memories/skills that landed in `proposed` status
3. Update the root `AGENTS_STEWARD.md` to note the migration
4. Delete this `.steward-migration/` directory once verified

## What Stays on the Global Steward

- Memories scoped to other projects (chat_mind, steward_acs, etc.)
- Skills unrelated to homely (deployment, auth0, etc.)
- All specs for non-homely apps (steward_acs, chat_mind, etc.)
- The global Steward instance continues serving other projects
