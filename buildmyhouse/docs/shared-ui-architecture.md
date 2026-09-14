# Shared workspace UI

The phone layout is a presentation layer over the same workspace state as desktop.

## Shared seams

| Behavior | Source of truth | Desktop and mobile touchpoints |
| --- | --- | --- |
| Plan / 3D / split view | `src/main.ts:setCameraPreset` | View menu, toolbar presets, mobile nav |
| Home state and edits | `src/core/store.ts`, `src/core/model.ts` | Plan engine, 3D view, properties panel |
| Furniture placement | `src/plan/engine.ts` and `src/ui/catalog-panel.ts` | Plan canvas and 3D floor placement |
| Selected-object editing | `src/ui/properties-panel.ts` | Desktop sidebar and mobile Properties tab |
| Responsive layout | `src/style.css` | Same DOM, desktop layout plus mobile media rules |

## Update rule for agents

When behavior changes, update the shared source of truth first. If that behavior has a desktop toolbar/menu binding and a mobile-nav binding, update both bindings and add one desktop plus one phone E2E assertion. Do not create a mobile-only model, plan engine, or 3D scene.

Mobile-only code belongs in the `#mobile-nav` binding and responsive CSS. It may choose which existing panel is visible, but it must call the same camera, catalog, properties, store, and model APIs used by desktop.
