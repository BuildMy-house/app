"""Orchestrator-side automation server (ws-protocol.md v1).

Adapters connect TO the orchestrator:
- homely automation client: WebSocket (`websockets` asyncio implementation);
- sh3d-driver: plain TCP, newline-delimited JSON, identical envelope.

First message from an adapter must be `hello`; afterwards the orchestrator
sends request envelopes `{id,type,params}` and expects exactly one response
per id. Unsolicited traffic other than hello is ignored.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from websockets.asyncio.server import ServerConnection, serve



class AdapterError(Exception):
    """The app rejected an automation request."""

    def __init__(self, error: str, code: str | None = None):
        super().__init__(f"{code}: {error}" if code else error)
        self.error = error
        self.code = code or "ADAPTER_ERROR"

DEFAULT_REQUEST_TIMEOUT = 30.0


class Session:
    """One connected adapter; correlates responses to pending requests by id."""

    def __init__(self, app: str, version: str | None, mode: str | None, send_fn):
        self.app = app
        self.version = version
        self.mode = mode
        self._send = send_fn
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._counter = 0

    async def request(
        self,
        command: str,
        params: dict[str, Any] | None = None,
        timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> Any:
        self._counter += 1
        rid = f"req-{self._counter}"
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._send(json.dumps({"id": rid, "type": command, "params": params or {}}))
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    def handle_message(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        rid = msg.get("id")
        fut = self._pending.get(str(rid)) if rid is not None else None
        if fut is not None and not fut.done():
            if msg.get("ok"):
                fut.set_result(msg.get("data", {}))
            else:
                fut.set_exception(AdapterError(str(msg.get("error", "unspecified error")), msg.get("code")))

    def fail_all(self, error: str, code: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(AdapterError(error, code))
        self._pending.clear()


class AutomationServer:
    """Listens on ephemeral WebSocket + TCP ports until `stop()`."""

    def __init__(self, host: str = "127.0.0.1", ws_port: int | None = None, tcp_port: int | None = None):
        self.host = host
        self._ws_port = ws_port
        self._tcp_port = tcp_port
        self.ws_port: int | None = None
        self.tcp_port: int | None = None
        self.sessions: dict[str, Session] = {}
        self._ws_server = None
        self._tcp_server = None

    async def start(self) -> None:
        self._ws_server = await serve(self._handle_ws, self.host, self._ws_port or 0)
        sock = self._ws_server.sockets[0]
        self.ws_port = sock.getsockname()[1]
        self._tcp_server = await asyncio.start_server(self._handle_tcp, self.host, self._tcp_port or 0)
        self.tcp_port = self._tcp_server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        for session in list(self.sessions.values()):
            session.fail_all("server stopped", "SERVER_STOPPED")
        if self._ws_server is not None:
            self._ws_server.close()
            await self._ws_server.wait_closed()
            self._ws_server = None
        if self._tcp_server is not None:
            self._tcp_server.close()
            await self._tcp_server.wait_closed()
            self._tcp_server = None

    async def wait_for_session(self, app: str, timeout: float = 10.0) -> Session:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            session = self.sessions.get(app)
            if session is not None:
                return session
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError(f"no adapter announced hello app='{app}' within {timeout}s")
            await asyncio.sleep(0.02)

    def _register(self, msg: dict[str, Any], send_fn) -> Session | None:
        if msg.get("type") != "hello":
            return None
        session = Session(str(msg.get("app", "unknown")), msg.get("version"), msg.get("mode"), send_fn)
        self.sessions[session.app] = session
        return session

    async def _handle_ws(self, ws: ServerConnection) -> None:
        session: Session | None = None
        try:
            with contextlib.suppress(Exception):
                async for raw in ws:
                    if session is None:
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        session = self._register(msg, ws.send)
                        continue
                    session.handle_message(raw)
        finally:
            if session is not None:
                self.sessions.pop(session.app, None)
                session.fail_all("adapter disconnected", "DISCONNECTED")

    async def _handle_tcp(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        session: Session | None = None

        async def send_line(text: str) -> None:
            writer.write(text.encode("utf-8") + b"\n")
            await writer.drain()

        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    continue
                if session is None:
                    session = self._register(msg, send_line)
                    continue
                session.handle_message(line.decode("utf-8").strip())
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            if session is not None:
                self.sessions.pop(session.app, None)
                session.fail_all("adapter disconnected", "DISCONNECTED")
