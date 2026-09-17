"""Product render profiles shared by the HTTP worker and tests."""
from __future__ import annotations

from typing import Any

PROFILES: dict[str, dict[str, Any]] = {
    "thumbnail": {
        "width": 256, "height": 256, "samples_per_pixel": 64,
        "seconds": 60, "denoise": "none", "adaptive": True,
        "noise_threshold": 0.8,
    },
    "low": {
        "width": 1280, "height": 720, "samples_per_pixel": 256,
        "seconds": 300, "denoise": "oidn", "adaptive": True,
        "noise_threshold": 0.35,
    },
    "medium": {
        "width": 1920, "height": 1080, "samples_per_pixel": 512,
        "seconds": 600, "denoise": "oidn", "adaptive": True,
        "noise_threshold": 0.25,
    },
    "high": {
        "width": 4096, "height": 4096, "samples_per_pixel": 4096,
        "seconds": 1800, "denoise": "oidn", "adaptive": True,
        "noise_threshold": 0.2,
    },
}


def settings_for(profile: str) -> dict[str, Any]:
    try:
        return dict(PROFILES[profile])
    except KeyError as exc:
        raise ValueError(f"unknown render profile {profile!r}; choose one of {sorted(PROFILES)}") from exc
