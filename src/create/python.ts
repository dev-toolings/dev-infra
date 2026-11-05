import versions from "../../data/versions.json";
import { fastapiFiles, importFrom, pythonModule } from "./fastapi";

export type PythonOptions = { name: string; pattern: string; orm: string; services: string[] };

/** Exact versions, kept in one file that `devhub versions` checks. */
const VERSIONS = versions.PyPI;
const list = (items: string[]) => `[\n${items.map((item) => `  "${item}",`).join("\n")}\n]`;

export function pythonFiles({ name, pattern, orm, services }: PythonOptions): Record<string, string> {
  const modules = pattern === "modules", sqlalchemy = orm === "sqlalchemy";
  const postgres = services.includes("postgres"), redis = services.includes("redis"), mail = services.includes("mailpit");
  const lib = modules ? "app/shared/infrastructure" : "app/lib";
  const files = fastapiFiles(name, modules, sqlalchemy);

  files["pyproject.toml"] = [
    "[project]", `name = "${name}"`, 'version = "0.1.0"', 'requires-python = ">=3.13"',
    `dependencies = ${list([
      `fastapi==${VERSIONS.fastapi}`, `pydantic-settings==${VERSIONS["pydantic-settings"]}`, `uvicorn==${VERSIONS.uvicorn}`,
      ...(postgres ? [`psycopg[binary]==${VERSIONS.psycopg}`] : []),
      ...(sqlalchemy ? [`alembic==${VERSIONS.alembic}`, `sqlalchemy==${VERSIONS.sqlalchemy}`] : []),
      ...(redis ? [`redis==${VERSIONS.redis}`] : []),
    ])}`, "",
    "[dependency-groups]", `dev = ${list([`httpx==${VERSIONS.httpx}`, `mypy==${VERSIONS.mypy}`, `pytest==${VERSIONS.pytest}`, `ruff==${VERSIONS.ruff}`])}`, "",
    "[tool.uv]", "package = false", "",
    "[tool.pytest.ini_options]", 'pythonpath = ["."]', "",
    "[tool.ruff]", "line-length = 100", "",
    "[tool.ruff.lint]", 'select = ["B", "E", "F", "I", "UP"]', "",
    "[tool.mypy]", "strict = true", "explicit_package_bases = true", 'files = ["app", "tests"]', 'plugins = ["pydantic.mypy"]', "",
  ].join("\n");
  files[".gitignore"] = [".env", ".venv/", "__pycache__/", ".mypy_cache/", ".pytest_cache/", ".ruff_cache/", ".claude/settings.local.json", ""].join("\n");
  files[".env.example"] = [
    "APP_ENV=development",
    ...(postgres ? ["DATABASE_URL="] : []),
    ...(redis ? ["REDIS_URL=", "REDIS_PREFIX="] : []),
    ...(mail ? ["SMTP_HOST=", "SMTP_PORT="] : []),
    "",
  ].join("\n");
  files["README.md"] = [
    `# ${name}`, "",
    "Created with DevHub. Start, stop and read logs from the DevHub panel or `devhub project`.", "",
    "```sh", "uv run ruff check .", "uv run ruff format --check .", "uv run mypy", "uv run pytest", "```", "",
    "In Docker, run these inside the `app` container: dependencies live there.", "",
    modules
      ? "Each feature lives in `app/modules/<name>`: `domain` holds the rules and the ports, `application` the use cases, `infrastructure` HTTP and storage. Dependencies point inward, a module shows only its `__init__.py`, and `app/main.py` wires them. `notes` is an example to copy or delete."
      : "`app/routes` holds the HTTP routes, `app/schemas` the request shapes, `app/services` the logic, `app/middleware` the access log and error handling, and `app/main.py` wires them. `notes` is an example to copy or delete.",
    "",
    ...(sqlalchemy ? ["`/notes` answers 500 until its table exists: run `uv run alembic upgrade head`.", ""] : []),
  ].join("\n");

  files["app/config.py"] = [
    "from typing import Literal", "",
    "from pydantic_settings import BaseSettings, SettingsConfigDict", "", "",
    "class Settings(BaseSettings):",
    '    model_config = SettingsConfigDict(env_file=".env", extra="ignore")', "",
    '    app_env: Literal["development", "production"] = "production"',
    ...(postgres ? ["    database_url: str"] : []),
    ...(redis ? ["    redis_url: str", '    redis_prefix: str = ""'] : []),
    ...(mail ? ["    smtp_host: str", "    smtp_port: int"] : []),
    "", "",
    "# Read once at startup: a missing variable stops the app with a clear error.",
    "settings = Settings()", "",
  ].join("\n");

  const imports = ["from app.app import create_app", "from app.config import settings", importFrom(pythonModule(`${lib}/logger`), "configure_logging")];
  const checks: string[] = [];
  if (postgres) {
    files[`${lib}/database.py`] = sqlalchemy ? [
      "from sqlalchemy import create_engine, text", "",
      "from app.config import settings", "",
      "# SQLAlchemy refuses the `postgres://` of DATABASE_URL.",
      'url = settings.database_url.replace("postgres://", "postgresql+psycopg://", 1)',
      'engine = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 2})', "", "",
      "def ping_database() -> None:",
      "    with engine.connect() as connection:",
      '        connection.execute(text("select 1"))', "",
    ].join("\n") : [
      "import psycopg", "",
      "from app.config import settings", "", "",
      "def ping_database() -> None:",
      "    with psycopg.connect(settings.database_url, connect_timeout=2) as connection:",
      '        connection.execute("select 1")', "",
    ].join("\n");
    imports.push(importFrom(pythonModule(`${lib}/database`), sqlalchemy ? "engine, ping_database" : "ping_database"));
    checks.push('HealthCheck("database", ping_database)');
  }
  if (sqlalchemy) {
    files[`${lib}/orm.py`] = [
      "from sqlalchemy.orm import DeclarativeBase", "", "",
      "class Base(DeclarativeBase):",
      '    """Separate from `database.py`: a test can read a table without a connection."""', "",
    ].join("\n");
    files["alembic.ini"] = ["[alembic]", "script_location = migrations", "prepend_sys_path = .", ""].join("\n");
    files["migrations/env.py"] = [
      ...(modules ? ["from importlib import import_module", "from pathlib import Path", ""] : []),
      "from alembic import context", "",
      `from ${pythonModule(`${lib}/database`)} import engine`,
      ...(modules ? [`from ${pythonModule(`${lib}/orm`)} import Base`, "", 'for schema in Path("app/modules").glob("*/infrastructure/persistence/schema.py"):', '    import_module(".".join(schema.with_suffix("").parts))'] : ["from app.lib.schema import Base"]),
      "",
      "with engine.connect() as connection:",
      "    context.configure(connection=connection, target_metadata=Base.metadata)",
      "    with context.begin_transaction():",
      "        context.run_migrations()", "",
    ].join("\n");
    files["migrations/script.py.mako"] = [
      '"""${message}', "", "Revision ID: ${up_revision}", '"""', "",
      "import sqlalchemy as sa", "from alembic import op", "${imports if imports else \"\"}", "",
      "revision = ${repr(up_revision)}", "down_revision = ${repr(down_revision)}", "branch_labels = ${repr(branch_labels)}", "depends_on = ${repr(depends_on)}", "", "",
      "def upgrade() -> None:", "    ${upgrades if upgrades else \"pass\"}", "", "",
      "def downgrade() -> None:", "    ${downgrades if downgrades else \"pass\"}", "",
    ].join("\n");
    files["migrations/versions/0001_notes.py"] = [
      '"""notes', "", "Revision ID: 0001", '"""', "",
      "import sqlalchemy as sa", "from alembic import op", "",
      'revision = "0001"', "down_revision = None", "branch_labels = None", "depends_on = None", "", "",
      "def upgrade() -> None:",
      "    op.create_table(",
      '        "notes",',
      '        sa.Column("id", sa.String(), primary_key=True),',
      '        sa.Column("body", sa.String(), nullable=False),',
      '        sa.Column("created_at", sa.String(), nullable=False),',
      "    )", "", "",
      "def downgrade() -> None:",
      '    op.drop_table("notes")', "",
    ].join("\n");
  }
  if (redis) {
    files[`${lib}/redis_client.py`] = [
      "from redis import Redis", "",
      "from app.config import settings", "",
      "redis_client = Redis.from_url(settings.redis_url, socket_timeout=2)", "", "",
      "def key(name: str) -> str:",
      '    """Redis is shared: every key starts with the prefix of this project."""',
      '    return f"{settings.redis_prefix}{name}"', "",
    ].join("\n");
    imports.push(importFrom(pythonModule(`${lib}/redis_client`), "redis_client"));
    checks.push('HealthCheck("redis", redis_client.ping)');
  }
  if (mail) {
    files[`${lib}/mailer.py`] = [
      "import smtplib", "from email.message import EmailMessage", "",
      "from app.config import settings", "", "",
      "def send_mail(message: EmailMessage) -> None:",
      "    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=5) as client:",
      "        client.send_message(message)", "",
    ].join("\n");
  }

  const store = `${sqlalchemy ? "Sqlalchemy" : "Memory"}${modules ? "NoteRepository" : "NoteStore"}`;
  if (checks.length > 0) imports.push(modules ? "from app.modules.health import HealthCheck" : "from app.routes.health import HealthCheck");
  if (modules) imports.push(`from app.modules.notes import ${store}`);
  else imports.push(sqlalchemy ? "from app.services.sqlalchemy_note_store import SqlalchemyNoteStore" : "from app.services.notes import MemoryNoteStore");
  const notes = `${store}(${sqlalchemy ? "engine" : ""})`;
  const call = `app = create_app(checks=[${checks.join(", ")}], notes=${notes})`;
  const multiline = checks.length > 0 && `    checks=[${checks.join(", ")}],`.length > 100
    ? ["app = create_app(", "    checks=[", ...checks.map((check) => `        ${check},`), "    ],", `    notes=${notes},`, ")"]
    : ["app = create_app(", `    checks=[${checks.join(", ")}],`, `    notes=${notes},`, ")"];
  files["app/main.py"] = [
    ...imports.sort(), "",
    'configure_logging(development=settings.app_env == "development")', "",
    ...(call.length <= 100 ? [call] : multiline), "",
  ].join("\n");
  return files;
}
