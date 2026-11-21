#!/usr/bin/env python3
"""Run a feature environment of a project DevHub created, on real Docker and the shared Postgres."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import runpy
import secrets
import tempfile

fixture = runpy.run_path(str(Path(__file__).with_name("feature-environments.py")))
run, wait_http, REPO = fixture["run"], fixture["wait_http"], fixture["REPO"]
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]


def main():
    if run([*DOCKER, "info", "--format", "{{.OSType}}"], check=False, timeout=20).returncode:
        raise SystemExit("SKIP: the local Docker daemon is unavailable")
    if run([*DOCKER, "inspect", "--format", "{{.State.Running}}", "infra-postgres"], check=False, timeout=20).stdout.strip() != "true":
        raise SystemExit("SKIP: infra-postgres is not running; start it with devhub up")
    with ExitStack() as cleanup:
        root = Path(cleanup.enter_context(tempfile.TemporaryDirectory(prefix="devhub-feature-project-")))
        for name in ("home", "state", "config", "runtime", "worktrees", "recipes", "sources"):
            (root / name).mkdir(mode=0o700)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("DEVHUB_", "DOCKER_", "COMPOSE_", "GIT_", "BUILDX_"))}
        env.update({
            "HOME": str(root / "home"), "XDG_STATE_HOME": str(root / "state"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_RUNTIME_DIR": str(root / "runtime"), "DEVHUB_WORKTREE_ROOT": str(root / "worktrees"), "DEVHUB_RECIPE_DIR": str(root / "recipes"),
        })
        cli = str(REPO / "bin/devhub")
        name = "fx" + secrets.token_hex(3)
        admin = run([*DOCKER, "exec", "infra-postgres", "printenv", "POSTGRES_USER"], env=env).stdout.strip()

        def sql(database, query):
            return run([*DOCKER, "exec", "infra-postgres", "psql", "-U", admin, "-d", database, "-v", "ON_ERROR_STOP=1", "-tAc", query], env=env).stdout.strip()

        def drop_project():
            # Only what this run created carries its random name.
            run([*DOCKER, "rm", "-f", f"devhub-{name}-app-1"], env=env, check=False)
            run([*DOCKER, "volume", "rm", f"devhub-{name}_node_modules"], env=env, check=False)
            run([*DOCKER, "image", "rm", f"devhub-{name}-app:latest"], env=env, check=False)
            for network in run([*DOCKER, "network", "ls", "--format", "{{.Name}}", "--filter", f"name=devhub-{name}-"], env=env).stdout.split():
                run([*DOCKER, "network", "disconnect", network, "infra-postgres"], env=env, check=False)
                run([*DOCKER, "network", "rm", network], env=env, check=False)
            sql("postgres", f'DROP DATABASE IF EXISTS "dh_{name}" WITH (FORCE)')
            sql("postgres", f'DROP ROLE IF EXISTS "dh_{name}"')

        cleanup.callback(drop_project)
        run([cli, "root", "add", str(root / "sources"), "--label", "feature-project", "--json"], env=env)
        run([cli, "new", "node", name, "--root", str(root / "sources"), "--mode", "docker", "--service", "postgres", "--apply", "--json"], env=env, timeout=900)
        source = root / "sources" / name
        run(["git", "-C", str(source), "add", "-A"], env=env)
        run(["git", "-C", str(source), "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-qm", "fixture"], env=env)
        sql(f"dh_{name}", "CREATE TABLE marker (v text); INSERT INTO marker VALUES ('project')")
        ids = []

        def command(*args, expected=0):
            argv = [*args[:args.index("--")], "--json", *args[args.index("--"):]] if "--" in args else [*args, "--json"]
            result = run([cli, "env", *argv], env=env, check=False, timeout=600)
            response = json.loads(result.stdout)
            data = response.get("data", response.get("error"))
            if args[0] == "create" and "data" in response:
                ids.append(data["id"])
            assert result.returncode == expected, (args, response, result.stderr)
            return data

        def remove():
            for id in ids:
                result = run([cli, "env", "destroy", id, "--purge-data", "--remove-worktrees", "--force", "--json"], env=env, check=False, timeout=300)
                for image in json.loads(result.stdout).get("data", {}).get("resources", {}).get("images", []):
                    run([*DOCKER, "image", "rm", image["reference"]], env=env, check=False)

        cleanup.callback(remove)
        feature = command("create", name, "--feature", "checkout")
        assert feature["observed"] == "ready" and feature["bootstrap"] == {"database-copy": "done"}, feature
        database = feature["database"]
        assert feature["preview"]["domainUrl"] == f"http://checkout-{feature['id'][3:11]}.{name}.localhost", feature["preview"]
        assert (REPO / "data/caddy/sites" / (feature["id"] + ".caddy")).exists()
        assert database == "dh_" + feature["id"].replace("-", "_")
        status, body = wait_http(feature["preview"]["url"] + "/health")
        assert status == 200 and json.loads(body)["checks"]["database"] is True
        wired = command("exec", feature["id"], "--service", "app", "--", "sh", "-c", 'echo "${DATABASE_URL##*/}"; pwd; id -u')["stdout"].split()
        assert wired == [database, "/app", str(os.getuid())], wired
        worktree = Path(feature["repos"][0]["path"])
        assert worktree != source and (worktree / "package.json").exists()

        # The copy holds the project rows; later writes stay on their side.
        assert sql(database, "SELECT string_agg(v, ',') FROM marker") == "project"
        sql(database, "INSERT INTO marker VALUES ('feature')")
        assert sql(f"dh_{name}", "SELECT string_agg(v, ',' ORDER BY v) FROM marker") == "project"
        (worktree / "FEATURE.md").write_text("feature only\n")
        assert not (source / "FEATURE.md").exists()

        assert command("stop", feature["id"])["observed"] == "stopped"
        restarted = command("start", feature["id"])
        assert restarted["observed"] == "ready" and sql(database, "SELECT string_agg(v, ',' ORDER BY v) FROM marker") == "feature,project"
        kept = command("destroy", feature["id"])
        assert kept["observed"] == "destroyed" and kept["database"] == database and worktree.exists()
        purged = command("destroy", feature["id"], "--purge-data", "--remove-worktrees", "--force")
        assert "database" not in purged and not worktree.exists()
        assert not (REPO / "data/caddy/sites" / (feature["id"] + ".caddy")).exists()
        assert sql("postgres", f"SELECT count(*) FROM pg_database WHERE datname = '{database}'") == "0"
        assert sql("postgres", f"SELECT count(*) FROM pg_roles WHERE rolname = '{database}'") == "0"
        assert sql(f"dh_{name}", "SELECT string_agg(v, ',') FROM marker") == "project"
        print("PASS: project feature with its own worktree, a private copy of the project database, stop, start, retained data and purge")


if __name__ == "__main__":
    main()
