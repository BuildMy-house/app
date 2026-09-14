"""Scenario DSL models for the equivalence harness.

A scenario is a platform-agnostic description of an automation run against one
or more adapters (sh3d-driver, homely, mock). Step commands and params mirror
docs/specs/ws-protocol.md v1 (FROZEN). All validation errors name the
offending step index / field path so agents can fix scenarios without a human.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CaptureKind = Literal["state", "plan", "3d"]

# Every adapter-executable command from docs/specs/ws-protocol.md v1.
# `hello` is intentionally absent: it is adapter->orchestrator only.
COMMANDS: frozenset[str] = frozenset(
    {
        "ping",
        "new_home",
        "open",
        "save",
        "select_tool",
        "move_mouse",
        "click",
        "drag",
        "key",
        "set_magnetism",
        "undo",
        "redo",
        "delete_selection",
        "copy",
        "paste",
        "duplicate",
        "select_all",
        "clear_selection",
        "select_object",
        "modify_selected",
        "add_furniture",
        "list_catalog",
        "zoom",
        "set_view",
        "set_camera",
        "camera_preset",
        "get_state",
        "screenshot",
        "get_capabilities",
        "add_room",
        "remove_level",
        "add_level",
        "add_dimension_line",
        "add_label",
        "add_door",
        "add_window",
    }
)

TOOLS = frozenset(
    {"selection", "panning", "wall", "room", "polyline", "dimensionLine", "label"}
)
KEYS = frozenset({"escape", "delete", "backspace"})
VIEWS = frozenset({"plan", "3d"})
CAMERA_PRESETS = frozenset({"top", "observer"})

Number = (int, float)

# command -> {param: allowed python types} for REQUIRED params.
REQUIRED_PARAMS: dict[str, dict[str, tuple[type, ...]]] = {
    "open": {"path": (str,)},
    "save": {"path": (str,)},
    "select_tool": {"tool": (str,)},
    "move_mouse": {"x": Number, "y": Number},
    "click": {"x": Number, "y": Number},
    "drag": {"fromX": Number, "fromY": Number, "toX": Number, "toY": Number},
    "key": {"key": (str,)},
    "set_magnetism": {"enabled": (bool,)},
    "select_object": {"objectId": (str,)},
    "modify_selected": {"props": (Mapping,)},
    "add_furniture": {"catalogId": (str,), "x": Number, "y": Number},
    "zoom": {"factor": Number},
    "set_view": {"view": (str,)},
    "set_camera": {
        "x": Number,
        "y": Number,
        "z": Number,
        "yawDeg": Number,
        "pitchDeg": Number,
        "fovDeg": Number,
    },
    "camera_preset": {"preset": (str,)},
    "screenshot": {"view": (str,), "width": (int,), "height": (int,)},
    "add_room": {"points": (list,)},
    "remove_level": {"id": (str,)},
    "add_level": {"name": (str,), "elevation": Number, "floorThickness": Number},
    "add_dimension_line": {"xStart": Number, "yStart": Number, "xEnd": Number, "yEnd": Number},
    "add_label": {"x": Number, "y": Number},
    "add_door": {"wallId": (str,)},
    "add_window": {"wallId": (str,)},
}

# command -> {param: allowed python types} for OPTIONAL params worth type-checking.
OPTIONAL_PARAMS: dict[str, dict[str, tuple[type, ...]]] = {
    "click": {"dbl": (bool,), "shift": (bool,), "altOrMeta": (bool,)},
    "drag": {"shift": (bool,), "altOrMeta": (bool,)},
    "add_furniture": {"angleDeg": Number},
}

# command -> {param: allowed values} for frozen protocol enums.
ENUM_PARAMS: dict[str, dict[str, frozenset[str]]] = {
    "select_tool": {"tool": TOOLS},
    "key": {"key": KEYS},
    "set_view": {"view": VIEWS},
    "screenshot": {"view": VIEWS},
    "camera_preset": {"preset": CAMERA_PRESETS},
}


def _type_name(types: tuple[type, ...]) -> str:
    return "|".join(t.__name__ for t in types)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Target(_Strict):
    """Platform selector; defaults reserved to linux-tauri per PLAN.md."""

    os: list[Literal["linux", "macos", "windows"]] = Field(default_factory=lambda: ["linux"])
    mode: list[Literal["tauri", "web"]] = Field(default_factory=lambda: ["tauri"])

    @model_validator(mode="after")
    def _nonempty_unique(self) -> Target:
        if not self.os:
            raise ValueError("target.os must not be empty")
        if not self.mode:
            raise ValueError("target.mode must not be empty")
        if len(set(self.os)) != len(self.os):
            raise ValueError(f"target.os has duplicate entries: {self.os}")
        if len(set(self.mode)) != len(self.mode):
            raise ValueError(f"target.mode has duplicate entries: {self.mode}")
        return self


class Step(_Strict):
    """One automation command.

    YAML form is a single-key mapping: `- click: {x: 100, y: 100}` where the
    key is the command type and the value its params object (`null`/absent
    value means no params).
    """

    command: str
    params: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="before")
    def _unwrap_single_key(data: Any) -> Any:
        if not isinstance(data, Mapping):
            return data
        keys = list(data.keys())
        if keys == ["command"] or set(keys) == {"command", "params"}:
            return data  # already in internal form (programmatic construction)
        if len(keys) != 1:
            raise ValueError(
                "each step must be a single-command mapping like "
                f"'click: {{x: 100, y: 100}}'; got {len(keys)} keys: {keys}"
            )
        ((command, params),) = data.items()
        return {"command": command, "params": {} if params is None else params}

    @model_validator(mode="after")
    def _validate_command(self) -> Step:
        if self.command not in COMMANDS:
            known = ", ".join(sorted(COMMANDS))
            raise ValueError(
                f"unknown command '{self.command}' (see docs/specs/ws-protocol.md); "
                f"known commands: {known}"
            )
        for param, types in REQUIRED_PARAMS.get(self.command, {}).items():
            if param not in self.params:
                raise ValueError(f"{self.command}: missing required param '{param}'")
            _check_type(self.command, param, self.params[param], types)
        for param, types in OPTIONAL_PARAMS.get(self.command, {}).items():
            if param in self.params:
                _check_type(self.command, param, self.params[param], types)
        for param, allowed in ENUM_PARAMS.get(self.command, {}).items():
            if param in self.params and self.params[param] not in allowed:
                raise ValueError(
                    f"{self.command}.{param}={self.params[param]!r} not in "
                    f"{sorted(allowed)}"
                )
        return self


def _check_type(command: str, param: str, value: Any, types: tuple[type, ...]) -> None:
    if bool not in types and isinstance(value, bool):
        ok = False  # bool is an int subclass; never accept it for numeric params
    else:
        ok = isinstance(value, types)
    if not ok:
        raise ValueError(
            f"{command}.{param} must be {_type_name(types)}, got {type(value).__name__}"
        )


class Checkpoint(_Strict):
    """Snapshot request: capture artifacts after step `afterStep` (1-based)."""

    afterStep: int = Field(ge=1)
    capture: list[CaptureKind] = Field(default_factory=lambda: ["state"])

    @model_validator(mode="after")
    def _nonempty_unique(self) -> Checkpoint:
        if not self.capture:
            raise ValueError(f"checkpoint afterStep={self.afterStep}: capture must not be empty")
        if len(set(self.capture)) != len(self.capture):
            raise ValueError(
                f"checkpoint afterStep={self.afterStep}: duplicate capture kinds in {self.capture}"
            )
        return self


class Assertion(_Strict):
    """Check evaluated against a captured artifact by the comparators."""

    at: int = Field(ge=1, description="checkpoint.afterStep this assertion attaches to")
    # NOTE: deliberately not named `on` — YAML 1.1 parses bare `on:` as boolean True.
    artifact: CaptureKind = "state"
    kind: Literal["count", "equals", "approx", "exists"]
    path: str = Field(min_length=1, description="dotted path into the captured artifact, e.g. 'walls'")
    value: Any = None
    tolerance: float = Field(default=0.01, gt=0)

    @model_validator(mode="after")
    def _kind_shape(self) -> Assertion:
        if self.kind == "count":
            if not isinstance(self.value, int) or isinstance(self.value, bool):
                raise ValueError(f"assertion kind='count' requires integer value, got {self.value!r}")
        elif self.kind == "approx":
            if not isinstance(self.value, Number) or isinstance(self.value, bool):
                raise ValueError(
                    f"assertion kind='approx' requires numeric value, got {self.value!r}"
                )
        elif self.kind == "equals" and self.value is None:
            raise ValueError("assertion kind='equals' requires a value")
        return self


class Scenario(_Strict):
    name: str = Field(min_length=1)
    description: str = ""
    target: Target = Field(default_factory=Target)
    setup: list[Step] = Field(default_factory=list)
    steps: list[Step] = Field(min_length=1)
    checkpoints: list[Checkpoint] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=list)

    @model_validator(mode="after")
    def _cross_check(self) -> Scenario:
        n = len(self.steps)
        seen: set[int] = set()
        for i, cp in enumerate(self.checkpoints):
            if cp.afterStep > n:
                raise ValueError(
                    f"checkpoints[{i}].afterStep={cp.afterStep} is out of range: "
                    f"scenario has only {n} steps"
                )
            if cp.afterStep in seen:
                raise ValueError(
                    f"checkpoints[{i}].afterStep={cp.afterStep} duplicates an earlier checkpoint"
                )
            seen.add(cp.afterStep)
        by_step = {cp.afterStep: cp for cp in self.checkpoints}
        for i, a in enumerate(self.assertions):
            cp = by_step.get(a.at)
            if cp is None:
                valid = ", ".join(str(s) for s in sorted(by_step)) or "none"
                raise ValueError(
                    f"assertions[{i}].at={a.at} references no checkpoint after that step "
                    f"(checkpoints defined at steps: {valid})"
                )
            if a.artifact not in cp.capture:
                raise ValueError(
                    f"assertions[{i}] checks artifact='{a.artifact}' but checkpoints at step "
                    f"{a.at} only capture {cp.capture}"
                )
        return self
