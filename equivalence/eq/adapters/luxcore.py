"""LuxCoreAdapter — wraps the LuxCoreRender sidecar as a harness Adapter.

Does NOT connect to the real SH3D or Homely. Instead:
1. Receives a NormalizedHomeState via set_home()
2. Converts it to RenderableScene via _home_to_scene
3. Sends the scene JSON to the LuxCore sidecar process
4. Returns the rendered PNG as screenshot_bytes()
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Any

from eq.adapters.base import Adapter, AdapterError


def _home_to_scene(home: dict[str, Any]) -> dict[str, Any]:
    """Convert a NormalizedHomeState dict to a LuxCore RenderableScene dict."""
    objects: list[dict[str, Any]] = []
    materials: dict[str, Any] = {
        "wall_mat": {"type": "matte", "kd": [0.7, 0.7, 0.7]},
        "floor_mat": {"type": "matte", "kd": [0.9, 0.9, 0.88]},
        "furniture_mat": {"type": "matte", "kd": [0.6, 0.6, 0.75]},
    }

    for wall in home.get("walls", []):
        objects.append({
            "type": "polygon",
            "name": wall["id"],
            "material": "wall_mat",
            "vertices": [
                [wall["xStart"], wall["yStart"]],
                [wall["xEnd"], wall["yEnd"]],
            ],
            "z": 0.0,
            "height": wall.get("height", 250.0),
        })

    for room in home.get("rooms", []):
        objects.append({
            "type": "polygon",
            "name": room["id"],
            "material": "floor_mat",
            "vertices": room["points"],
            "z": 0.0,
            "height": 0.0,
        })

    for furn in home.get("furniture", []):
        w, d, h = furn["width"], furn["depth"], furn["height"]
        objects.append({
            "type": "box",
            "name": furn["id"],
            "material": "furniture_mat",
            "size": [w / 100.0, d / 100.0, h / 100.0],
        })

    cameras = home.get("cameras", {})
    cam = cameras.get("top", {})
    cam_x = cam.get("x", 0.0)
    cam_y = cam.get("y", 0.0)
    cam_z = cam.get("z", 10.0)

    return {
        "materials": materials,
        "objects": objects,
        "lights": [
            {"type": "directional", "name": "sun", "direction": [0, 0, -1], "gain": [1, 1, 1]},
        ],
        "camera": {
            "lookat": [[cam_x, cam_y, cam_z], [cam_x, cam_y, 0], [0, 1, 0]],
            "fov": cam.get("fovDeg", 60.0),
        },
    }


class LuxCoreAdapter(Adapter):
    """Harness Adapter that renders via the LuxCore sidecar subprocess."""

    app = "luxcore"

    def __init__(self, name: str = "luxcore"):
        self.name = name
        self._home: dict[str, Any] | None = None
        self._proc: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        try:
            self._proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "eq.luxcore.renderer",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise AdapterError(
                "failed to launch LuxCore sidecar", "SIDECAR_START_FAILED"
            ) from exc

    async def stop(self) -> None:
        if self._proc and self._proc.returncode is None:
            self._proc.stdin.close()
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5.0)
            except TimeoutError:
                self._proc.kill()

    def set_home(self, home: dict[str, Any]) -> None:
        """Store a NormalizedHomeState for rendering."""
        self._home = home

    async def request(self, command: str, params: dict[str, Any] | None = None) -> Any:
        params = params or {}
        if command == "new_home":
            self._home = None
            return {}
        if command == "get_state":
            if self._home is None:
                raise AdapterError("no home loaded", "NO_HOME")
            return self._home
        if command == "screenshot":
            return await self._render(params)
        raise AdapterError(f"unknown command '{command}'", "UNKNOWN_COMMAND")

    async def screenshot_bytes(self, view: str = "plan", width: int = 800, height: int = 600) -> bytes:
        data = await self._render({"view": view, "width": width, "height": height})
        return base64.b64decode(data["pngBase64"])

    async def _render(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._home is None:
            raise AdapterError("no home loaded", "NO_HOME")
        if self._proc is None or self._proc.returncode is not None:
            raise AdapterError("sidecar not running", "SIDECAR_NOT_RUNNING")

        scene = _home_to_scene(self._home)
        line = json.dumps(scene) + "\n"

        try:
            self._proc.stdin.write(line.encode())
            await self._proc.stdin.drain()
        except (BrokenPipeError, OSError) as exc:
            raise AdapterError("sidecar stdin broken", "SIDECAR_BROKEN") from exc

        try:
            response = await asyncio.wait_for(
                self._proc.stdout.readline(), timeout=60.0
            )
        except TimeoutError:
            raise AdapterError("sidecar render timed out", "RENDER_TIMEOUT")

        response = response.decode().strip()
        if not response:
            stderr_out = await self._proc.stderr.read(4096)
            raise AdapterError(
                f"sidecar returned empty response: {stderr_out.decode().strip()[:200]}",
                "RENDER_FAILED",
            )

        return {
            "pngBase64": response,
            "width": params.get("width", 800),
            "height": params.get("height", 600),
        }
