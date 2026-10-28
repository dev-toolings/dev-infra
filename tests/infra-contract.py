#!/usr/bin/env python3
"""Render only: prove retained shared infrastructure identity against main."""
import json
import os
import subprocess


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs)


def main_source():
    for ref in ("e8f5e5a",):
        result = subprocess.run(["git", "show", f"{ref}:compose.yml"], text=True, capture_output=True)
        if result.returncode == 0:
            return result.stdout
    raise AssertionError("Cannot find baseline e8f5e5a:compose.yml; use fetch-depth:0 before this check")


def render(profile, source=None):
    env = {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_CONFIG", "XDG_CONFIG_HOME") if key in os.environ}
    env["COMPOSE_PROFILES"] = profile
    args = ["docker", "compose", "--project-name", "dev-infra", "--project-directory", os.getcwd(), "--env-file", ".env.example", "-f", "-" if source else "compose.yml", "config", "--format", "json"]
    return json.loads(command(args, input=source, env=env))


source = main_source()
expected = {"postgres", "mysql", "redis", "meilisearch", "mailpit", "adminer", "dozzle", "rabbitmq"}
for profile in ("core", "async", "core,async"):
    before, after = render(profile, source), render(profile)
    assert before["volumes"] == after["volumes"], "Volume identity changed"
    assert before["networks"] == after["networks"], "Network identity changed"
    assert before["services"].keys() == after["services"].keys(), "Profile membership changed"
    for name, service in before["services"].items():
        assert name in expected, f"Unexpected shared service: {name}"
        current = after["services"][name]
        for field in ("container_name", "profiles", "ports", "volumes", "networks", "hostname"):
            assert service.get(field) == current.get(field), f"{profile}: {name} {field} changed"
        assert current["logging"] == {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}, name
    if profile == "core,async":
        assert set(after["services"]) == expected
        assert after["services"]["rabbitmq"]["environment"]["RABBITMQ_NODENAME"] == "rabbit@infra-rabbitmq"
        assert after["services"]["redis"]["command"][-2:] == ["--aclfile", ""]
        for name in ("mailpit", "adminer", "dozzle"):
            assert "@sha256:" in after["services"][name]["image"], name
    print(f"PASS infrastructure identity: {profile}")
