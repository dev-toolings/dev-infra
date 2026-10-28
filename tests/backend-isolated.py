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
args = parser.parse_args()
bun = shutil.which("bun")
if not bun:
    raise SystemExit("Bun is required for backend checks")

with tempfile.TemporaryDirectory(prefix="devhub-backend-") as directory:
    root = Path(directory)
    for name in ("home", "state", "runtime", "bin"):
        (root / name).mkdir(mode=0o700)
    log = root / "unexpected-tools"
    for tool in ("docker", "docker-compose", "systemctl", "journalctl"):
        shim = root / "bin" / tool
        shim.write_text("#!/bin/sh\n"
                        f"printf '%s\\n' {shlex.quote(tool)} >> {shlex.quote(str(log))}\n"
                        "exit 97\n")
        shim.chmod(0o700)
    environment = dict(os.environ, HOME=str(root / "home"),
                       XDG_STATE_HOME=str(root / "state"),
                       XDG_RUNTIME_DIR=str(root / "runtime"),
                       PATH=f"{root / 'bin'}:{os.environ.get('PATH', '')}")
    result = subprocess.run([bun, "test", "src"], cwd=args.repo.resolve(), env=environment)
    unexpected = log.read_text() if log.exists() else ""
    if unexpected:
        print("FAIL: backend tests attempted live tool calls:", unexpected, flush=True)
        raise SystemExit(1)
    if result.returncode:
        raise SystemExit(result.returncode)
    print("PASS: isolated backend fixtures made no live Docker/systemd calls")
