#!/usr/bin/env python3
"""Check that a real Vite dev server pushes hot updates through a feature preview, on real Docker."""
from contextlib import ExitStack
import base64
import json
import os
import re
from pathlib import Path
import runpy
import socket
import struct
import tempfile
import time

fixture = runpy.run_path(str(Path(__file__).with_name("feature-environments.py")))
run, git, wait_http, REPO = fixture["run"], fixture["git"], fixture["wait_http"], fixture["REPO"]
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]

COMPOSE = """services:
  web:
    image: oven/bun:1-alpine
    working_dir: /app
    environment:
      HOME: /tmp
      BUN_INSTALL_CACHE_DIR: /tmp/bun-cache
    command: ["bunx", "--bun", "vite@7", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
    volumes:
      - ./:/app
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:5173/"]
      interval: 2s
      timeout: 2s
      retries: 60
"""


def frames(connection, buffer=b""):
    """Yield the text payloads of unmasked server frames."""
    while True:
        while len(buffer) < 2:
            buffer += connection.recv(65536)
        length, offset = buffer[1] & 0x7F, 2
        if length == 126:
            while len(buffer) < 4:
                buffer += connection.recv(65536)
            length, offset = struct.unpack("!H", buffer[2:4])[0], 4
        elif length == 127:
            while len(buffer) < 10:
                buffer += connection.recv(65536)
            length, offset = struct.unpack("!Q", buffer[2:10])[0], 10
        while len(buffer) < offset + length:
            buffer += connection.recv(65536)
        opcode, payload, buffer = buffer[0] & 0x0F, buffer[offset:offset + length], buffer[offset + length:]
        if opcode == 1:
            yield payload.decode("utf-8")


def main():
    if run([*DOCKER, "info", "--format", "{{.OSType}}"], check=False, timeout=20).returncode:
        raise SystemExit("SKIP: the local Docker daemon is unavailable")
    with ExitStack() as cleanup:
        root = Path(cleanup.enter_context(tempfile.TemporaryDirectory(prefix="devhub-feature-hmr-")))
        for name in ("home", "state", "config", "runtime", "worktrees", "recipes", "sources"):
            (root / name).mkdir(mode=0o700)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("DEVHUB_", "DOCKER_", "COMPOSE_", "GIT_", "BUILDX_"))}
        env.update({
            "HOME": str(root / "home"), "XDG_STATE_HOME": str(root / "state"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_RUNTIME_DIR": str(root / "runtime"), "DEVHUB_WORKTREE_ROOT": str(root / "worktrees"), "DEVHUB_RECIPE_DIR": str(root / "recipes"),
        })
        cli = str(REPO / "bin/devhub")
        source = root / "sources" / "web"
        source.mkdir()
        (source / "compose.yml").write_text(COMPOSE)
        (source / "index.html").write_text('<!doctype html><title>hmr</title><script type="module" src="/main.js"></script>\n')
        (source / "main.js").write_text('import "./style.css";\ndocument.title = "hmr";\n')
        (source / "style.css").write_text("body { color: black; }\n")
        (source / ".gitignore").write_text("node_modules/\n")
        run(["git", "init", "--initial-branch=main", str(source)])
        git(source, "add", ".")
        run(["git", "-C", str(source), "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-qm", "fixture"])
        run([cli, "root", "add", str(root / "sources"), "--label", "feature-hmr", "--json"], env=env)
        recipe = {
            "version": 1, "repositories": {"web": {"path": str(source), "ref": "main"}},
            "compose": {"repository": "web", "files": [{"repository": "web", "path": "compose.yml"}], "services": ["web"]},
            "routes": [{"path": "/", "service": "web", "port": 5173}],
            # Vite is downloaded at start: the dev server alone keeps a route out.
            "isolation": "hardened", "internet": ["web"], "resources": {"cpus": 2, "memoryMiB": 1024}, "idleMinutes": 60,
        }
        (root / "recipes/hmr.json").write_text(json.dumps(recipe))
        created = run([cli, "env", "create", "hmr", "--feature", "vite", "--json"], env=env, check=False, timeout=600)
        feature = json.loads(created.stdout).get("data")
        if feature:
            cleanup.callback(run, [cli, "env", "destroy", feature["id"], "--purge-data", "--remove-worktrees", "--force", "--json"], env=env, check=False, timeout=300)
        assert created.returncode == 0 and feature["observed"] == "ready", created.stdout[-2000:]
        port = feature["preview"]["port"]
        assert wait_http(f"http://127.0.0.1:{port}/")[0] == 200
        worktree = Path(feature["repos"][0]["path"])

        # Vite only accepts the HMR socket with the token its client script carries.
        client = wait_http(f"http://127.0.0.1:{port}/@vite/client")[1].decode()
        token = re.search(r'const wsToken = "([^"]+)"', client).group(1)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        with socket.create_connection(("127.0.0.1", port), timeout=30) as connection:
            connection.sendall((
                f"GET /?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n"
                f"Origin: http://127.0.0.1:{port}\r\n\r\n"
            ).encode("ascii"))
            response = b""
            while b"\r\n\r\n" not in response:
                response += connection.recv(4096)
            headers, rest = response.split(b"\r\n\r\n", 1)
            assert b"101 Switching Protocols" in headers, headers
            messages = frames(connection, rest)
            assert json.loads(next(messages))["type"] == "connected"
            # Vite only pushes updates for modules a browser loaded: request them like the page would.
            wait_http(f"http://127.0.0.1:{port}/main.js")
            wait_http(f"http://127.0.0.1:{port}/style.css")
            time.sleep(1)
            (worktree / "style.css").write_text("body { color: rebeccapurple; }\n")
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                message = json.loads(next(messages))
                if message["type"] in ("update", "full-reload"):
                    break
            else:
                raise AssertionError("Vite sent no hot update through the preview")
        assert message["type"] == "update" and any(item["path"] == "/style.css" for item in message["updates"]), message
        assert (worktree / "style.css").stat().st_uid == os.getuid()
        print("PASS: a Vite dev server in a hardened feature pushes a hot CSS update through the preview WebSocket")


if __name__ == "__main__":
    main()
