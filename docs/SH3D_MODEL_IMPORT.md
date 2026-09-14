# Sweet Home 3D Model Import Guide

This guide explains how to import models from Sweet Home 3D with embedded textures, so they render with proper colors instead of white.

## Quick Start

```bash
# From project root
bash scripts/download-sh3d-models.sh

# Then from buildmyhouse directory
cd buildmyhouse
npm run import:sh3d -- --skip-upload

# This creates GLB files with textures baked in
```

## How It Works

1. **Download** — Fetch SH3D model archives from SourceForge
2. **Extract** — Unzip to `.sh3d-scratch/extracted/sh3f/`
3. **Convert** — Load OBJ+MTL models and convert to GLB with textures embedded
4. **Bake Textures** — Materials and textures are baked into each GLB file
5. **Update Catalog** — Models are registered in the catalog with proper metadata

## Step-by-Step Process

### 1. Download SH3D Models

```bash
# Automatic download (recommended)
bash scripts/download-sh3d-models.sh

# Or manual download
# Visit: https://sourceforge.net/projects/sweethome3d/files/3DModels/
# Download 3DModels-1.9.3.zip
# Extract to: .sh3d-scratch/extracted/
```

### 2. Convert Models to GLB with Textures

```bash
cd buildmyhouse

# Convert and generate GLB files locally (no upload)
npm run import:sh3d -- --skip-upload

# This:
# - Reads OBJ files and MTL material definitions
# - Loads all textures (PNG, JPEG, etc.)
# - Bakes textures into GLB models
# - Creates .sh3d-scratch/output/models/*.glb files
```

### 3. Verify Textures

```bash
# List some models with their dimensions
npm run ingest:list sofa | head -30

# Check a specific model was created
ls -lh .sh3d-scratch/output/models/sofa*.glb
```

### 4. Update the Catalog

```bash
# Merge converted models into the catalog
npm run import:sh3d -- --merge-catalog

# This:
# - Scans .sh3d-scratch/output/models/*.glb
# - Extracts metadata from the conversion checkpoint
# - Updates assets/catalog/catalog.json
# - Regenerates tags for searchability
```

### 5. Deploy Models

Models are now in `assets/catalog/` directory. When you build:

```bash
npm run build

# All models with textures are included in the bundle
# No external URLs needed (no R2 upload required for local use)
```

## Upload to Cloudflare R2 (Optional)

If you want to host models externally (for large deployments):

```bash
# Set R2 credentials as environment variables
export R2_ACCOUNT_ID=your_account_id
export R2_ACCESS_KEY_ID=your_key
export R2_SECRET_ACCESS_KEY=your_secret
export R2_BUCKET_NAME=models
export R2_PUBLIC_URL=https://cdn.example.com

# Convert, upload, and verify
npm run import:sh3d

# This:
# - Converts OBJ→GLB with textures
# - Uploads to R2
# - Verifies uploads succeeded
# - Updates catalog with R2 URLs
```

## Available Models

SH3D 3DModels-1.9.3 includes ~1500 models across:

- **Furniture** — Sofas, chairs, tables, beds, desks
- **Kitchen** — Appliances, cabinets, counters
- **Bathroom** — Fixtures, toilets, sinks
- **Doors & Windows** — Various styles and sizes
- **Decorative** — Plants, picture frames, artwork
- **Lighting** — Lamps, fixtures, chandeliers
- **Outdoor** — Garden furniture, decor
- **Structural** — Stairs, railings, partitions

All models come with:
- ✅ **Textures** — Full color/material definitions
- ✅ **Proper UVs** — Texture coordinates for correct mapping
- ✅ **Realistic Materials** — Wood, fabric, ceramic, glass, etc.
- ✅ **Multiple Sources** — Licensed under CC-BY, FAL, CC0

## Troubleshooting

### Models Still Render White

1. **Verify textures were baked:**
   ```bash
   # Check GLB file size (should be > 100KB if textures embedded)
   ls -lh .sh3d-scratch/output/models/ | head -5
   ```

2. **Check if models were merged into catalog:**
   ```bash
   # Should show models with modelPath
   npm run ingest:list | grep "modelPath"
   ```

3. **Clear cache and rebuild:**
   ```bash
   rm -rf dist/
   npm run build
   npm run dev
   ```

### Conversion Failed

1. **Check for missing MTL files:**
   ```bash
   grep -r "Failed to load" .sh3d-scratch/output/ || echo "No errors"
   ```

2. **Verify source files extracted:**
   ```bash
   ls .sh3d-scratch/extracted/sh3f/*/PluginFurnitureCatalog.properties | wc -l
   # Should be > 0
   ```

3. **Rerun conversion with more detail:**
   ```bash
   npm run import:sh3d -- --skip-upload 2>&1 | tee conversion.log
   ```

## Performance Notes

- **First conversion** — 5-15 minutes (depends on CPU and disk speed)
- **File sizes** — Each GLB is 50KB-5MB with embedded textures
- **Bundle size** — Full set is ~500MB uncompressed
- **Caching** — Once converted, no need to re-run unless adding new models

## Adding Custom Models

To add your own models with textures:

1. Create a `custom-models/` directory
2. Place OBJ+MTL+textures there
3. Use the ingestion pipeline:
   ```bash
   npm run ingest:models --add-from-spec custom-spec.json
   ```

## See Also

- [Model Ingestion Pipeline](../buildmyhouse/scripts/model-ingestion.ts)
- [SH3D Import Script](../buildmyhouse/scripts/import-sh3d-library.ts)
- [Model Loading Tests](../buildmyhouse/src/view3d/model-loading.test.ts)
