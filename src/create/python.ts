import versions from "../../data/versions.json";

export type PythonOptions = { name: string; pattern: string; services: string[] };

/** Exact versions, kept in one file that `devhub versions` checks. */
const VERSIONS = versions.PyPI;
const list = (items: string[]) => `[\n${items.map((item) => `  "${item}",`).join("\n")}\n]`;

export function pythonFiles({ name, pattern, services }: PythonOptions): Record<string, string> {
  const modules = pattern === "modules";
  const routes = modules ? "app/modules/health/infrastructure/http/routes" : "app/routes/health";
  const dependencies = [
    `fastapi==${VERSIONS.fastapi}`, `uvicorn==${VERSIONS.uvicorn}`,
    ...(services.includes("postgres") ? [`psycopg[binary]==${VERSIONS.psycopg}`] : []),
    ...(services.includes("redis") ? [`redis==${VERSIONS.redis}`] : []),
  ];
  return {
    "pyproject.toml": [
      "[project]", `name = "${name}"`, 'version = "0.1.0"', 'requires-python = ">=3.13"', `dependencies = ${list(dependencies)}`, "",
      "[dependency-groups]", `dev = ${list([`pytest==${VERSIONS.pytest}`, `httpx==${VERSIONS.httpx}`, `ruff==${VERSIONS.ruff}`])}`, "",
      "[tool.uv]", "package = false", "",
      "[tool.pytest.ini_options]", 'pythonpath = ["."]', "",
    ].join("\n"),
    "app/main.py": [
      "from fastapi import FastAPI", "", `from ${routes.replaceAll("/", ".")} import router as health_router`, "",
      "app = FastAPI()", "app.include_router(health_router)", "",
    ].join("\n"),
    [`${routes}.py`]: [
      "from fastapi import APIRouter", "", "router = APIRouter()", "", "",
      '@router.get("/health")', "def health() -> dict[str, str]:", '    return {"status": "ok"}', "",
    ].join("\n"),
    "tests/test_health.py": [
      "from fastapi.testclient import TestClient", "", "from app.main import app", "", "",
      "def test_health() -> None:", '    response = TestClient(app).get("/health")', "    assert response.status_code == 200", "",
    ].join("\n"),
    ".gitignore": [".env", ".venv/", "__pycache__/", ".claude/settings.local.json", ""].join("\n"),
  };
}
