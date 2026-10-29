#!/usr/bin/env python3
"""Run backend fixtures with private user paths and forbidden live-tool shims."""
import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument("--test-path", default="src")
parser.add_argument("--deny-git", action="store_true")
args = parser.parse_args()
bun = shutil.which("bun")
if not bun:
    raise SystemExit("Bun is required for backend checks")

with tempfile.TemporaryDirectory(prefix="devhub-backend-") as directory:
    root = Path(directory)
    for name in ("home", "state", "runtime", "config", "bin"):
        (root / name).mkdir(mode=0o700)
    log = root / "unexpected-tools"
    for tool in ("docker", "docker-compose", "systemctl", "journalctl", "busctl", "dbus-send", "systemd-run", *(("git",) if args.deny_git else ())):
        shim = root / "bin" / tool
        shim.write_text("#!/bin/sh\n"
                        f"printf '%s\\n' {shlex.quote(tool)} >> {shlex.quote(str(log))}\n"
                        "exit 97\n")
        shim.chmod(0o700)
    environment = dict(os.environ, HOME=str(root / "home"),
                       XDG_CONFIG_HOME=str(root / "config"),
                       XDG_STATE_HOME=str(root / "state"),
                       XDG_RUNTIME_DIR=str(root / "runtime"),
                       PATH=f"{root / 'bin'}:{os.environ.get('PATH', '')}")
    environment = {key: value for key, value in environment.items()
                   if key not in ("DBUS_SESSION_BUS_ADDRESS", "DEVHUB_DIR") and not key.startswith("DOCKER_")}
    result = subprocess.run([bun, "--no-env-file", "test", args.test_path], cwd=args.repo.resolve(), env=environment)
    unexpected = log.read_text() if log.exists() else ""
    if unexpected:
        print("FAIL: backend tests attempted live tool calls:", unexpected, flush=True)
        raise SystemExit(1)
    if result.returncode:
        raise SystemExit(result.returncode)
    print("PASS: isolated backend fixtures made no live Docker/systemd calls")
