#!/usr/bin/env python3
"""Exercise isolated feature environments with real Git, Docker and HTTP requests."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from contextlib import ExitStack
import urllib.error
import urllib.request
import uuid


REPO = Path(__file__).resolve().parent.parent
EXAMPLE = REPO / "data/examples/feature-environment"


def run(args, *, cwd=None, env=None, check=True, timeout=120):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError(f"Command failed ({result.returncode}): {args}\n{result.stdout}\n{result.stderr}")
    return result


def git(repo, *args):
    return run(["git", "-C", str(repo), *args])


def git_sha(repo, ref="HEAD"):
    return git(repo, "rev-parse", ref).stdout.strip()


def wait_http(url, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                return response.status, response.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.25)
    raise AssertionError(f"Timed out waiting for {url}")


def websocket_message(host, port, path="/api/ws"):
    """Perform a minimal RFC 6455 handshake and read the server's first frame."""
    import base64
    import os as _os
    import struct

    key = base64.b64encode(_os.urandom(16)).decode("ascii")
    with socket.create_connection((host, port), timeout=5) as connection:
        connection.sendall((
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response:
            response += connection.recv(4096)
        headers, frame = response.split(b"\r\n\r\n", 1)
        assert b"101 Switching Protocols" in headers, headers
        while len(frame) < 2:
            frame += connection.recv(4096)
        length = frame[1] & 0x7F
        offset = 2
        if length == 126:
            while len(frame) < 4:
                frame += connection.recv(4096)
            length = struct.unpack("!H", frame[2:4])[0]
            offset = 4
        elif length == 127:
            while len(frame) < 10:
                frame += connection.recv(4096)
            length = struct.unpack("!Q", frame[2:10])[0]
            offset = 10
        while len(frame) < offset + length:
            frame += connection.recv(4096)
        return frame[offset:offset + length].decode("utf-8")


def make_git_fixtures(root):
    repos = {}
    (root / "sources").mkdir(mode=0o700)
    for name in ("frontend", "api", "deployment"):
        path = root / "sources" / name
        shutil.copytree(EXAMPLE / name, path)
        run(["git", "init", "--initial-branch=main", str(path)])
        git(path, "add", ".")
        run(["git", "-C", str(path), "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-m", "fixture"])
        repos[name] = path
    return repos


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--five", action="store_true", help="create five concurrent feature checkouts")
    args = parser.parse_args()
    for tool in ("docker", "git"):
        if not shutil.which(tool):
            raise SystemExit(f"SKIP: {tool} is not installed")
    docker = run(["docker", "--host=unix:///var/run/docker.sock", "info"], check=False, timeout=20)
    if docker.returncode:
        raise SystemExit("SKIP: Docker daemon is unavailable")
    devhub = REPO / "bin/devhub"
    if not devhub.exists():
        raise SystemExit(f"FAIL: missing CLI entry point: {devhub}")

    with ExitStack() as cleanup_stack:
        temp = cleanup_stack.enter_context(tempfile.TemporaryDirectory(prefix="devhub-feature-env-"))
        root = Path(temp)
        for name in ("home", "state", "config", "runtime", "worktrees", "recipes"):
            (root / name).mkdir(mode=0o700)
        repos = make_git_fixtures(root)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("DOCKER_", "DEVHUB_", "COMPOSE_", "BUILDX_", "GIT_"))}
        env.update({
            "HOME": str(root / "home"),
            "XDG_STATE_HOME": str(root / "state"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_RUNTIME_DIR": str(root / "runtime"),
            "DEVHUB_WORKTREE_ROOT": str(root / "worktrees"),
            "DEVHUB_RECIPE_DIR": str(root / "recipes"),
        })
        if args.five:
            env["DEVHUB_FEATURE_MAX_ACTIVE"] = "5"
            env["DEVHUB_FEATURE_MAX_BUILDS"] = "5"

        docker_args = ["docker", "--host=unix:///var/run/docker.sock"]
        main_stack = run([*docker_args, "ps", "-q", "--filter", "label=com.docker.compose.project=dev-infra"], env=env).stdout.split()
        primary_url = None
        if not args.five:
            primary_file = root / "primary.json"
            primary_file.write_text(json.dumps({"services": {"web": {
                "image": "node:22-alpine", "command": ["node", "/app/server.js"],
                "ports": [{"target": 3000, "host_ip": "127.0.0.1"}],
                "volumes": [{"type": "bind", "source": str(repos["frontend"]), "target": "/app", "read_only": True}],
            }}}))
            primary = [*docker_args, "compose", "--env-file", "/dev/null", "-p", "devhub-primary-fixture-" + uuid.uuid4().hex, "-f", str(primary_file)]
            cleanup_stack.callback(run, [*primary, "down"], env=env)
            run([*primary, "up", "-d", "--no-build"], env=env)
            primary_url = "http://" + run([*primary, "port", "web", "3000"], env=env).stdout.strip()
            assert wait_http(primary_url + "/")[0] == 200
        active_environments = set()

        def remove_fixture_images(environment_id, resources):
            for image in resources.get("images", []):
                reference = image.get("reference", "")
                if not reference.startswith("devhub-env-"):
                    continue
                inspected = run(["docker", "--host=unix:///var/run/docker.sock", "image", "inspect",
                                 "--format", "{{.Id}} {{index .Config.Labels \"com.devhub.feature\"}}", reference], env=env, check=False)
                if inspected.returncode == 0:
                    assert inspected.stdout.strip() == f"{image['id']} {environment_id}", f"fixture image identity changed: {reference}"
                    run(["docker", "--host=unix:///var/run/docker.sock", "image", "rm", reference], env=env)

        def cleanup_environments():
            for environment_id in tuple(active_environments):
                destroyed = run([str(devhub), "env", "destroy", environment_id, "--purge-data", "--remove-worktrees", "--force", "--json"],
                                env=env, timeout=300)
                remove_fixture_images(environment_id, json.loads(destroyed.stdout)["data"]["resources"])

        cleanup_stack.callback(cleanup_environments)

        # Replace only the documented repository path tokens in the versioned sample recipe.
        recipe_text = (EXAMPLE / "recipe.v1.json").read_text()
        for name, path in repos.items():
            recipe_text = recipe_text.replace(f"/ABSOLUTE/PATH/TO/{name}", str(path))
        api_ref = git_sha(repos["api"])
        git(repos["api"], "branch", "fixture-baseline", api_ref)
        run(["git", "-C", str(repos["api"]), "-c", "user.email=fixture@example.invalid",
             "-c", "user.name=fixture", "commit", "--allow-empty", "-m", "advance API branch"])
        recipe = json.loads(recipe_text)
        recipe["repositories"]["api"]["ref"] = "fixture-baseline"
        recipe_path = root / "recipes" / "fixture.json"
        recipe_path.write_text(json.dumps(recipe))
        recipe_path.chmod(0o600)
        run([str(devhub), "root", "add", str(root / "sources"), "--label", "feature-fixture", "--json"], env=env)

        # Exercise simultaneous requests for two feature branches of one project.
        outputs = {}
        failures = []

        def create_environment(label, key):
            result = run([str(devhub), "env", "create", "fixture", "--feature", label,
                          "--idempotency-key", key, "--json"], env=env, check=False, timeout=300)
            response = {}
            if result.stdout.strip():
                try:
                    response = json.loads(result.stdout)
                    environment_id = response.get("data", {}).get("id")
                    if environment_id:
                        active_environments.add(environment_id)
                except json.JSONDecodeError:
                    pass
            if result.returncode:
                record = response.get("data", {})
                detail = record.get("operation", {}).get("error", response.get("error", {}))
                if record.get("id"):
                    operations = run([str(devhub), "env", "logs", record["id"], "--service", "operation", "--tail", "12", "--json"],
                                     env=env, check=False)
                    detail["log"] = json.loads(operations.stdout)["data"][0]["stdout"] if operations.returncode == 0 else operations.stderr
                raise AssertionError(f"Create {label} failed: {detail or result.stderr}")
            return response

        feature_names = {"alpha": "alpha/foo", "beta": "alpha foo"}

        def create(label, key):
            try:
                outputs[label] = create_environment(feature_names.get(label, label), key)
            except Exception as error:
                failures.append((label, str(error)))

        labels = ["alpha", "beta"] + (["gamma", "delta", "epsilon"] if args.five else [])
        initial_frontend_sha = git_sha(repos["frontend"], "main")
        threads = [threading.Thread(target=create, args=(label, f"fixture-{label}")) for label in labels]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert not failures, failures
        assert set(outputs) == set(labels)
        alpha = outputs["alpha"]["data"]
        beta = outputs["beta"]["data"]
        assert alpha["id"] != beta["id"]
        assert alpha["composeProject"] != beta["composeProject"]
        assert alpha["slug"] == beta["slug"]
        for item in outputs.values():
            environment = item["data"]
            assert environment["observed"] == "ready"
            api_checkout = next(repo for repo in environment["repos"] if repo["name"] == "api")
            assert api_checkout["ref"] == "fixture-baseline" and api_checkout["sha"] == api_ref
        alpha_repo = next(item for item in alpha["repos"] if item["name"] == "frontend")
        beta_repo = next(item for item in beta["repos"] if item["name"] == "frontend")
        assert alpha_repo["path"] != beta_repo["path"]
        assert alpha_repo["branch"] != beta_repo["branch"]
        assert alpha_repo["sha"] == beta_repo["sha"] == initial_frontend_sha

        upstream = repos["frontend"] / "UPSTREAM.txt"
        upstream.write_text("upstream moved after feature creation\n")
        git(repos["frontend"], "add", "UPSTREAM.txt")
        run(["git", "-C", str(repos["frontend"]), "-c", "user.email=fixture@example.invalid",
             "-c", "user.name=fixture", "commit", "-m", "advance upstream"])
        assert git_sha(repos["frontend"], "main") != initial_frontend_sha
        for item, repo in ((alpha_repo, repos["frontend"]), (beta_repo, repos["frontend"])):
            assert git_sha(Path(item["path"])) == initial_frontend_sha

        replay = run([str(devhub), "env", "create", "fixture", "--feature", feature_names["alpha"],
                      "--idempotency-key", "fixture-alpha", "--json"], env=env, timeout=300)
        assert json.loads(replay.stdout)["data"]["id"] == alpha["id"]
        conflict = run([str(devhub), "env", "create", "fixture", "--feature", "different-feature",
                        "--idempotency-key", "fixture-alpha", "--json"], env=env, check=False, timeout=300)
        assert conflict.returncode != 0 and json.loads(conflict.stdout)["error"]["code"] == "idempotency_conflict"

        for label in labels[2:]:
            item = outputs[label]["data"]
            destroyed = run([str(devhub), "env", "destroy", item["id"], "--purge-data", "--remove-worktrees", "--json"], env=env, timeout=300)
            active_environments.discard(item["id"])
            remove_fixture_images(item["id"], json.loads(destroyed.stdout)["data"]["resources"])

        started = {item["id"]: item for item in (alpha, beta)}
        assert alpha["preview"]["port"] != beta["preview"]["port"]
        for item in (alpha, beta):
            tested = run([str(devhub), "env", "test", item["id"], "--json"], env=env)
            assert json.loads(tested.stdout)["data"]["operation"]["state"] == "succeeded"
            frontend = next(container for container in item["resources"]["containers"] if container["service"] == "frontend")
            limits = run(["docker", "--host=unix:///var/run/docker.sock", "inspect", "--format",
                          "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{len .HostConfig.PortBindings}}",
                          frontend["id"]], env=env).stdout.strip()
            assert limits == "2000000000 2147483648 0", limits
        for item in (started[alpha["id"]], started[beta["id"]]):
            port = item["preview"]["port"]
            status, page = wait_http(f"http://127.0.0.1:{port}/")
            assert status == 200 and b"/api/health" in page and b"/api/ws" in page
            status, health = wait_http(f"http://127.0.0.1:{port}/api/health")
            assert status == 200 and json.loads(health)["service"] == "api"
            assert websocket_message("127.0.0.1", port) == "same-origin websocket reached API"

        def sql(environment_id, query):
            result = run([str(devhub), "env", "exec", environment_id, "postgres", "--json", "--",
                          "psql", "-U", "fixture", "-d", "fixture", "-v", "ON_ERROR_STOP=1", "-At", "-c", query],
                         env=env, timeout=60)
            return json.loads(result.stdout)

        sql(alpha["id"], "CREATE TABLE IF NOT EXISTS fixture_values (value text PRIMARY KEY)")
        sql(alpha["id"], "INSERT INTO fixture_values VALUES ('alpha-only')")
        sql(beta["id"], "CREATE TABLE IF NOT EXISTS fixture_values (value text PRIMARY KEY)")
        sql(beta["id"], "INSERT INTO fixture_values VALUES ('beta-only')")
        assert sql(alpha["id"], "SELECT value FROM fixture_values")["data"]["stdout"].strip() == "alpha-only"
        assert sql(beta["id"], "SELECT value FROM fixture_values")["data"]["stdout"].strip() == "beta-only"
        alpha_volume = started[alpha["id"]]["resources"]["volumes"][0]["name"]
        beta_volume = started[beta["id"]]["resources"]["volumes"][0]["name"]
        assert alpha_volume != beta_volume and alpha_volume != "fixture-postgres-data" and beta_volume != "fixture-postgres-data"

        # Change code in A without touching B or the original checkout.
        alpha_source = Path(alpha_repo["path"]) / "server.js"
        original = alpha_source.read_text()
        alpha_source.write_text(original + "\n// A-only, uncommitted\n")
        dirty_destroy = run([str(devhub), "env", "destroy", alpha["id"], "--remove-worktrees", "--json"],
                            env=env, check=False, timeout=300)
        assert dirty_destroy.returncode != 0
        assert json.loads(dirty_destroy.stdout)["data"]["operation"]["error"]["code"] == "dirty_worktree"
        assert (Path(beta_repo["path"]) / "server.js").read_text() == original
        assert (repos["frontend"] / "server.js").read_text() == original

        # Rebuild B with an observable code change without replacing A's frontend image.
        beta_source = Path(beta_repo["path"]) / "server.js"
        beta_source.write_text(original.replace("Feature environment fixture", "Rebuilt beta fixture"))
        rebuilt = run([str(devhub), "env", "start", beta["id"], "--build", "--json"], env=env, timeout=600)
        beta_after = json.loads(rebuilt.stdout)["data"]
        _, page = wait_http(beta_after["preview"]["url"] + "/")
        assert b"Rebuilt beta fixture" in page
        beta_source.write_text(original)

        run([str(devhub), "env", "stop", alpha["id"], "--json"], env=env, timeout=300)
        restarted = run([str(devhub), "env", "start", alpha["id"], "--json"], env=env, timeout=300)
        alpha_after = json.loads(restarted.stdout)["data"]
        assert alpha_after["observed"] == "ready"
        assert wait_http(alpha_after["preview"]["url"] + "/api/health")[0] == 200
        assert alpha_after["configuration"]["fingerprint"] == alpha["configuration"]["fingerprint"]
        original_images = {resource["service"]: resource["imageId"] for resource in alpha["resources"]["containers"]}
        assert {resource["service"]: resource["imageId"] for resource in alpha_after["resources"]["containers"]} == original_images
        assert alpha_source.read_text().endswith("// A-only, uncommitted\n")
        assert sql(alpha["id"], "SELECT value FROM fixture_values")["data"]["stdout"].strip() == "alpha-only"

        # Destroy A while B is running. The first removal keeps A's data and dirty checkout.
        retained = run([str(devhub), "env", "destroy", alpha["id"], "--json"], env=env, timeout=300)
        retained = json.loads(retained.stdout)["data"]
        assert retained["observed"] == "destroyed" and not retained["resources"]["containers"] and not retained["resources"]["networks"]
        assert retained["resources"]["volumes"] == [{"name": alpha_volume}] and alpha_source.exists()
        assert wait_http(beta_after["preview"]["url"] + "/api/health")[0] == 200
        assert sql(beta["id"], "SELECT value FROM fixture_values")["data"]["stdout"].strip() == "beta-only"
        if primary_url:
            assert b"Feature environment fixture" in wait_http(primary_url + "/")[1]
        for environment in (alpha, beta):
            destroyed = run([str(devhub), "env", "destroy", environment["id"], "--purge-data", "--remove-worktrees", "--force", "--json"], env=env, timeout=300)
            removed = json.loads(destroyed.stdout)["data"]
            assert not removed["resources"]["volumes"] and all(repo["removed"] for repo in removed["repos"])
            active_environments.discard(environment["id"])
            remove_fixture_images(environment["id"], removed["resources"])
        assert not any((root / "worktrees").iterdir()), "feature worktrees survived delete"

        state_root = root / "state" / "devhub"
        assert state_root.exists()
        for path in state_root.rglob("*"):
            if path.is_file():
                assert path.stat().st_mode & 0o077 == 0, f"state file permissions are too broad: {path}"
        current_main_stack = set(run(["docker", "--host=unix:///var/run/docker.sock", "ps", "-q",
                                      "--filter", "label=com.docker.compose.project=dev-infra"], env=env).stdout.split())
        assert set(main_stack) <= current_main_stack, "a previously running shared DevHub container stopped during the fixture"
    print(f"PASS: {len(labels)} concurrent features, distinct Git refs, databases, builds, previews, WebSocket and safe lifecycle")


if __name__ == "__main__":
    main()
