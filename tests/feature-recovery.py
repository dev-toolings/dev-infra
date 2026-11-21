#!/usr/bin/env python3
"""Exercise feature environment readiness, capacity and interrupted bootstrap on real Docker."""
from contextlib import ExitStack
import json
import re
import os
from pathlib import Path
import runpy
import signal
import subprocess
import tempfile
import time
import uuid

fixture = runpy.run_path(str(Path(__file__).with_name("feature-environments.py")))
run, git, make_git_fixtures = (fixture[key] for key in ("run", "git", "make_git_fixtures"))
REPO, EXAMPLE = fixture["REPO"], fixture["EXAMPLE"]
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]


def main():
    if run([*DOCKER, "info", "--format", "{{.OSType}}"], check=False, timeout=20).returncode:
        raise SystemExit("SKIP: the local Docker daemon is unavailable")
    with ExitStack() as cleanup:
        root = Path(cleanup.enter_context(tempfile.TemporaryDirectory(prefix="devhub-feature-recovery-")))
        for name in ("home", "state", "recipes", "config", "runtime", "worktrees"):
            (root / name).mkdir(mode=0o700)
        repos = make_git_fixtures(root)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("DEVHUB_", "DOCKER_", "COMPOSE_", "GIT_", "BUILDX_"))}
        env.update({
            "HOME": str(root / "home"), "XDG_STATE_HOME": str(root / "state"),
            "XDG_RUNTIME_DIR": str(root / "runtime"), "XDG_CONFIG_HOME": str(root / "config"),
            "DEVHUB_RECIPE_DIR": str(root / "recipes"), "DEVHUB_WORKTREE_ROOT": str(root / "worktrees"),
            "DEVHUB_FEATURE_MAX_ACTIVE": "1", "FIXTURE_ENV": "inherited-incorrect",
        })
        cli = str(REPO / "bin/devhub")
        run([cli, "root", "add", str(root / "sources"), "--label", "feature-recovery", "--json"], env=env)
        recipe = json.loads((EXAMPLE / "recipe.v1.json").read_text())
        for name, path in repos.items():
            recipe["repositories"][name]["path"] = str(path)
            recipe["repositories"][name]["ref"] = "main"
        recipe["compose"]["vars"]["FIXTURE_ENV"] = "from-recipe"
        external = "devhub-feature-fixture-" + uuid.uuid4().hex
        external_label = "com.devhub.fixture=" + external
        run([*DOCKER, "volume", "create", "--label", external_label, external], env=env)
        cleanup.callback(run, [*DOCKER, "volume", "rm", external], env=env)
        recipe["shared"]["volumes"] = [external]
        recipe["idleMinutes"] = 1440
        recipe["steps"] = [
            {"id": "migrate", "phase": "migrate", "service": "api", "argv": ["test", "-f", "/tmp/migration-ready"]},
            {"id": "seed", "phase": "seed", "service": "api", "retry": "manual",
             "argv": ["sh", "-c", "if test -f /tmp/allow-seed; then echo seeded >> /tmp/fixture-seeded; else sleep 6; echo partial >> /tmp/fixture-seeded; fi"],
             "timeoutSeconds": 15},
        ]
        recipe_path = root / "recipes/recovery.json"
        recipe_path.write_text(json.dumps(recipe))
        compose = repos["deployment"] / "compose.yml"
        source = compose.read_text()
        compose.write_text(source.replace(
            "  api:\n", "  api:\n    environment:\n      FIXTURE_ENV: ${FIXTURE_ENV}\n    volumes:\n      - external-fixture:/fixture-shared:ro\n"
        ) + f"  external-fixture:\n    name: {external}\n    external: true\n")
        git(repos["deployment"], "add", "compose.yml")
        run(["git", "-C", str(repos["deployment"]), "-c", "user.email=fixture@example.invalid",
             "-c", "user.name=fixture", "commit", "-m", "recipe environment"])
        ids = set()

        def command(*args, expected=0):
            if "--" in args:
                index = args.index("--")
                argv = [*args[:index], "--json", *args[index:]]
            else:
                argv = [*args, "--json"]
            result = run([cli, "env", *argv], env=env, check=False, timeout=300)
            response = json.loads(result.stdout)
            if args[0] == "create" and "data" in response:
                ids.add(response["data"]["id"])
            assert result.returncode == expected, (args, result.returncode, response, result.stderr)
            assert response["version"] == 1
            return response.get("data", response.get("error"))

        def remove():
            for id in ids:
                result = run([cli, "env", "destroy", id, "--purge-data", "--remove-worktrees", "--force", "--json"],
                             env=env, check=False, timeout=300)
                if result.returncode:
                    raise AssertionError("Fixture cleanup could not remove a feature: " + result.stdout)
                for image in json.loads(result.stdout)["data"]["resources"]["images"]:
                    run([*DOCKER, "image", "rm", image["reference"]], env=env, check=False)

        cleanup.callback(remove)
        failed = command("create", "recovery", "--feature", "migrate fails", "--idempotency-key", "recovery", expected=1)
        id = failed["id"]
        assert failed["observed"] == "error" and failed["operation"]["error"]["code"] == "step_failed"
        assert failed["bootstrap"] == {"migrate": "failed"}
        assert command("status", id, expected=1)["observed"] == "error"
        assert command("create", "recovery", "--feature", "over capacity", expected=1)["code"] == "capacity_active"
        assert command("exec", id, "--service", "api", "--", "printenv", "FIXTURE_ENV")["stdout"].strip() == "from-recipe"
        command("exec", id, "--service", "api", "--", "touch", "/tmp/migration-ready")

        # The Docker resources already exist. Interrupt the parent while it is waiting for the seed.
        child = subprocess.Popen([cli, "env", "start", id, "--json"], env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and child.poll() is None:
                current = next(item for item in command("list") if item["id"] == id)
                if current["bootstrap"].get("seed") == "running":
                    child.send_signal(signal.SIGKILL)
                    child.wait(timeout=10)
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("Didn't observe the running bootstrap before interruption")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)

        recovered = next(item for item in command("reconcile") if item["id"] == id)
        assert recovered["operation"]["state"] == "interrupted", recovered["operation"]
        assert recovered["observed"] == "error"
        uncertain = command("start", id, expected=1)
        assert uncertain["operation"]["error"]["code"] == "manual_step_retry"
        command("exec", id, "--service", "api", "--", "touch", "/tmp/allow-seed")
        ready = command("start", id, "--retry-step", "seed")
        assert ready["observed"] == "ready" and ready["bootstrap"] == {"migrate": "done", "seed": "done"}
        assert len(ready["resources"]["containers"]) == 4
        assert {item["id"] for item in ready["resources"]["containers"]} == {item["id"] for item in failed["resources"]["containers"]}
        command("start", id)
        lines = command("exec", id, "--service", "api", "--", "cat", "/tmp/fixture-seeded")["stdout"].splitlines()
        assert lines.count("seeded") == 1, lines
        api = next(item for item in ready["resources"]["containers"] if item["service"] == "api")
        run([*DOCKER, "stop", "--time", "1", api["id"]], env=env)
        assert command("status", id)["observed"] == "degraded"
        assert command("start", id)["observed"] == "ready"
        command("destroy", id, "--purge-data")
        assert external in run([*DOCKER, "volume", "ls", "--filter", "label=" + external_label, "--format", "{{.Name}}"], env=env).stdout.split()

        # A path pointing at the original checkout must fail before any feature containers start.
        bad_compose = source.replace("  api:\n", "  api:\n    volumes:\n      - " + str(repos["frontend"]) + ":/outside\n")
        compose.write_text(bad_compose)
        git(repos["deployment"], "add", "compose.yml")
        run(["git", "-C", str(repos["deployment"]), "-c", "user.email=fixture@example.invalid",
             "-c", "user.name=fixture", "commit", "-m", "unsafe bind fixture"])
        unsafe = command("create", "recovery", "--feature", "unsafe bind", expected=1)
        assert unsafe["operation"]["error"]["code"] == "compose_invalid" and not unsafe["resources"]["containers"]

        # Hardened isolation: no capability beyond the recipe's, the host user in a worktree mount, no Internet.
        compose.write_text(source.replace("  api:\n", "  api:\n    volumes:\n      - ${DEVHUB_REPO_API}:/app\n"))
        git(repos["deployment"], "add", "compose.yml")
        run(["git", "-C", str(repos["deployment"]), "-c", "user.email=fixture@example.invalid",
             "-c", "user.name=fixture", "commit", "-m", "hardened fixture"])
        hardened = {**recipe, "isolation": "hardened", "shared": {"networks": [], "volumes": []}, "steps": [],
                    "capabilities": {"postgres": ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]}}
        (root / "recipes/hardened.json").write_text(json.dumps(hardened))
        created = run([cli, "env", "create", "hardened", "--feature", "hardened", "--json"], env=env, check=False, timeout=300)
        sandbox = json.loads(created.stdout)["data"]
        ids.add(sandbox["id"])
        if sandbox["observed"] != "ready":
            for container in sandbox["resources"]["containers"]:
                state = run([*DOCKER, "inspect", "--format", "{{json .State}} {{json .NetworkSettings.Ports}}", container["id"]], env=env, check=False)
                logs = run([*DOCKER, "logs", "--tail", "20", container["id"]], env=env, check=False)
                print(container["service"], state.stdout.strip(), (logs.stdout + logs.stderr)[-1500:])
        assert sandbox["observed"] == "ready", sandbox["operation"]
        assert fixture["wait_http"](sandbox["preview"]["url"] + "/api/health")[0] == 200
        api = lambda *argv: command("exec", sandbox["id"], "--service", "api", "--", *argv)
        assert api("id", "-u")["stdout"].strip() == str(os.getuid())
        status = api("cat", "/proc/self/status")["stdout"]
        assert re.search(r"CapEff:\s+0{16}\s", status) and re.search(r"CapBnd:\s+0{16}\s", status), status
        api("touch", "/app/hardened-owner")
        worktree = next(repo["path"] for repo in sandbox["repos"] if repo["name"] == "api")
        assert (Path(worktree) / "hardened-owner").stat().st_uid == os.getuid()
        offline = command("exec", sandbox["id"], "--service", "api", "--", "node", "-e",
                          "fetch('https://example.com').then(() => process.exit(0), () => process.exit(7))", expected=7)
        assert offline["code"] == 7, offline
        print("PASS: failed migration, capacity, clean interpolation, interrupted bootstrap, retry, readiness drift, wrong checkout, external volume retention and hardened isolation")


if __name__ == "__main__":
    main()
