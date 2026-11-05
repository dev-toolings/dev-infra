/** `app/lib/errors.py` as the module `app.lib.errors`. */
export const pythonModule = (file: string) => file.replace(/\.py$/, "").replaceAll("/", ".");

/** The line Ruff would write: one import, wrapped past 100 columns. */
export const importFrom = (module: string, names: string) => {
  const line = `from ${module} import ${names}`;
  return line.length <= 100 ? line : `from ${module} import (\n    ${names.split(", ").join(",\n    ")},\n)`;
};

const LOGGER = `"""JSON for a collector, and one readable line per event in development."""

import json
import logging
import os
import re
import sys
import time
from typing import Any

SECRET_KEYS = frozenset({"authorization", "cookie", "password", "token", "secret", "api_key"})
CENSOR = "[redacted]"

# Attributes of every record: what is left came from \`extra\`.
RECORD_ATTRS = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}
# Already placed on the line, never repeated as key=value.
RENDERED_KEYS = frozenset({"method", "path", "status", "duration_ms"})

ANSI = {
    "reset": "\\033[0m",
    "bold": "\\033[1m",
    "gray": "\\033[90m",
    "red": "\\033[31m",
    "green": "\\033[32m",
    "yellow": "\\033[33m",
    "blue": "\\033[34m",
    "bg_red": "\\033[41m",
}
LEVEL_COLORS = {
    "CRITICAL": "bg_red",
    "ERROR": "red",
    "WARNING": "yellow",
    "INFO": "green",
    "DEBUG": "blue",
}


def fields_of(record: logging.LogRecord) -> dict[str, Any]:
    return {
        key: CENSOR if key.lower() in SECRET_KEYS else value
        for key, value in record.__dict__.items()
        if key not in RECORD_ATTRS and value is not None
    }


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": round(record.created * 1000),
            "logger": record.name,
            "msg": record.getMessage(),
            **fields_of(record),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, ensure_ascii=False)


class PrettyFormatter(logging.Formatter):
    def __init__(self, *, color: bool) -> None:
        super().__init__()
        self.color = color

    def paint(self, name: str, text: str) -> str:
        return f"{ANSI[name]}{text}{ANSI['reset']}" if self.color else text

    def format_status(self, status: int) -> str:
        name = "red" if status >= 500 else "yellow" if status >= 400 else "green"
        return self.paint(name, str(status))

    @staticmethod
    def format_value(value: Any) -> str:
        if isinstance(value, str):
            return json.dumps(value, ensure_ascii=False) if re.search(r'[\\s"=]', value) else value
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, default=str, ensure_ascii=False)
        return str(value)

    def format(self, record: logging.LogRecord) -> str:
        clock = time.strftime("%H:%M:%S", time.localtime(record.created))
        level = self.paint(LEVEL_COLORS.get(record.levelname, "reset"), record.levelname)
        fields = fields_of(record)
        message = record.getMessage()
        if message == "http request" and isinstance(fields.get("status"), int):
            method = self.paint("bold", str(fields.get("method")))
            status = self.format_status(fields["status"])
            message = f"{method} {fields.get('path')} {status} {fields.get('duration_ms')}ms"
        rest = " ".join(
            f"{key}={self.format_value(value)}"
            for key, value in fields.items()
            if key not in RENDERED_KEYS
        )
        line = f"[{clock}.{int(record.msecs):03d}] {level}: {message}"
        if rest:
            line += f"  {self.paint('gray', rest)}"
        if record.exc_info:
            line += f"\\n{self.formatException(record.exc_info)}"
        return line


def configure_logging(*, development: bool) -> None:
    """One handler on the root logger, which uvicorn joins."""
    handler = logging.StreamHandler(sys.stdout)
    # Forced: DevHub reads logs through a pipe, where a TTY check turns colors off.
    color = not os.environ.get("NO_COLOR")
    handler.setFormatter(PrettyFormatter(color=color) if development else JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.DEBUG if development else logging.INFO)
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers[:] = []
        logger.propagate = True
`;

const ERRORS = `from typing import Literal

ErrorCode = Literal["invalid", "not_found"]


class AppError(Exception):
    """An expected failure. It knows nothing of HTTP: the error handler picks the status."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message
`;

const ACCESS_LOG = `import logging
import re
from collections.abc import Awaitable, Callable
from time import perf_counter
from uuid import uuid4

from fastapi import Request, Response
from fastapi.responses import JSONResponse

logger = logging.getLogger("app")
REQUEST_ID = re.compile(r"[\\w=-]{1,255}")


async def access_log(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """One line per request, and the answer to a failure that no handler knows."""
    started = perf_counter()
    given = request.headers.get("x-request-id", "")
    request_id = given if REQUEST_ID.fullmatch(given) else str(uuid4())
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("unhandled error", extra={"request_id": request_id})
        request.state.error_code = "internal"
        message = f"Internal server error ({request_id})"
        response = JSONResponse(
            {"error": {"code": "internal", "message": message}}, status_code=500
        )
    response.headers["X-Request-Id"] = request_id
    status = response.status_code
    fields = {
        "request_id": request_id,
        "method": request.method,
        "path": request.url.path,
        "route": getattr(request.scope.get("route"), "path", None),
        "status": status,
        "duration_ms": round((perf_counter() - started) * 1000),
        "error_code": getattr(request.state, "error_code", None),
    }
    level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.INFO
    logger.log(level, "http request", extra=fields)
    return response
`;

const errorHandlers = (errors: string) => `from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

${importFrom(errors, "AppError, ErrorCode")}

STATUS: dict[ErrorCode, int] = {"invalid": 400, "not_found": 404}


def fail(request: Request, status: int, code: str, message: str) -> JSONResponse:
    request.state.error_code = code
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def register_error_handlers(app: FastAPI) -> None:
    """Every failure leaves as the same JSON. An unknown one is answered by \`access_log\`."""

    @app.exception_handler(AppError)
    def handle_app_error(request: Request, error: AppError) -> JSONResponse:
        return fail(request, STATUS[error.code], error.code, error.message)

    @app.exception_handler(HTTPException)
    def handle_http_error(request: Request, error: HTTPException) -> JSONResponse:
        if error.status_code == 404:
            return fail(request, 404, "not_found", "Route not found")
        return fail(request, error.status_code, "http_error", str(error.detail))

    @app.exception_handler(RequestValidationError)
    def handle_invalid(request: Request, error: RequestValidationError) -> JSONResponse:
        issues = [
            ".".join(str(part) for part in issue["loc"][1:]) + f": {issue['msg']}"
            for issue in error.errors()
        ]
        return fail(request, 400, "invalid", "; ".join(issues))
`;

const NOTE_INPUT = `from pydantic import BaseModel, Field


class NoteInput(BaseModel):
    """The shape of a request. Business rules stay out of it."""

    body: str = Field(max_length=10_000)
`;

const PASSES = `# Under the 3 seconds DevHub waits, so that a hanging dependency still gives a report.
CHECK_TIMEOUT_SECONDS = 2


async def passes(check: HealthCheck) -> tuple[str, bool]:
    try:
        await asyncio.wait_for(asyncio.to_thread(check.run), CHECK_TIMEOUT_SECONDS)
    except Exception:
        return check.name, False
    return check.name, True
`;

const HEALTH_TYPES = `@dataclass(frozen=True)
class HealthCheck:
    name: str
    run: Callable[[], object]


@dataclass(frozen=True)
class HealthReport:
    status: Literal["ok", "degraded"]
    checks: dict[str, bool]
`;

const noteRoutes = (imports: string[], port: string, calls: Record<"all" | "create" | "get" | "update" | "delete", string>) => `from typing import Annotated

from fastapi import APIRouter, Depends, Request

${[...imports].sort().join("\n")}

router = APIRouter()


def get_notes(request: Request) -> ${port}:
    notes: ${port} = request.app.state.notes
    return notes


Notes = Annotated[${port}, Depends(get_notes)]


@router.get("/notes")
def read_notes(notes: Notes) -> list[Note]:
    return ${calls.all}(notes)


@router.post("/notes", status_code=201)
def post_note(notes: Notes, note: NoteInput) -> Note:
    return ${calls.create}(notes, note.body)


@router.get("/notes/{note_id}")
def read_note(notes: Notes, note_id: str) -> Note:
    return ${calls.get}(notes, note_id)


@router.patch("/notes/{note_id}")
def patch_note(notes: Notes, note_id: str, note: NoteInput) -> Note:
    return ${calls.update}(notes, note_id, note.body)


@router.delete("/notes/{note_id}", status_code=204)
def remove_note(notes: Notes, note_id: str) -> None:
    ${calls.delete}(notes, note_id)
`;

const sqlalchemyAdapter = (imports: string[], name: string) => `from sqlalchemy import Engine, select
from sqlalchemy.orm import sessionmaker

${[...imports].sort().join("\n")}


def to_note(row: NoteRow) -> Note:
    return Note(row.id, row.body, row.created_at)


class ${name}:
    def __init__(self, engine: Engine) -> None:
        self.sessions = sessionmaker(engine)

    def all(self) -> list[Note]:
        with self.sessions() as session:
            rows = session.scalars(select(NoteRow).order_by(NoteRow.created_at))
            return [to_note(row) for row in rows]

    def find(self, note_id: str) -> Note | None:
        with self.sessions() as session:
            row = session.get(NoteRow, note_id)
            return to_note(row) if row else None

    def save(self, note: Note) -> None:
        with self.sessions.begin() as session:
            session.merge(NoteRow(id=note.id, body=note.body, created_at=note.created_at))

    def delete(self, note_id: str) -> bool:
        with self.sessions.begin() as session:
            row = session.get(NoteRow, note_id)
            if row is None:
                return False
            session.delete(row)
            return True
`;

const noteRow = (orm: string) => `from sqlalchemy.orm import Mapped, mapped_column

${importFrom(orm, "Base")}


class NoteRow(Base):
    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(primary_key=True)
    body: Mapped[str]
    created_at: Mapped[str]
`;

const appFile = (name: string, imports: string[], port: string) => `from fastapi import FastAPI

${[...imports].sort().join("\n")}


def create_app(*, checks: list[HealthCheck], notes: ${port}) -> FastAPI:
    app = FastAPI(title=${JSON.stringify(name)})
    app.state.checks = checks
    app.state.notes = notes
    app.middleware("http")(access_log)
    register_error_handlers(app)

    @app.get("/")
    def root() -> dict[str, str]:
        return {"name": ${JSON.stringify(name)}, "health": "/health"}

    app.include_router(health_router)
    app.include_router(note_router)
    return app
`;

const appTest = (imports: string[], store: string) => `from typing import NoReturn

from fastapi.testclient import TestClient

${[...imports].sort().join("\n")}


def new_client(checks: list[HealthCheck] | None = None) -> TestClient:
    return TestClient(create_app(checks=checks or [], notes=${store}()))


def broken() -> None:
    raise RuntimeError("down")


def test_health_answers_503_when_a_dependency_fails() -> None:
    response = new_client([HealthCheck("database", broken)]).get("/health")
    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "checks": {"database": False}}


def test_a_note_can_be_created_read_and_deleted() -> None:
    client = new_client()
    created = client.post("/notes", json={"body": " hello "})
    assert created.status_code == 201
    note = created.json()
    assert note["body"] == "hello"
    assert client.get(f"/notes/{note['id']}").status_code == 200
    assert client.patch(f"/notes/{note['id']}", json={"body": "bye"}).json()["body"] == "bye"
    assert client.delete(f"/notes/{note['id']}").status_code == 204
    assert client.get(f"/notes/{note['id']}").status_code == 404


def test_every_failure_answers_the_same_json_with_a_request_id() -> None:
    client = new_client()
    headers = {"Content-Type": "application/json"}
    for response, status, code in [
        (client.post("/notes", json={"body": "   "}), 400, "invalid"),
        (client.post("/notes", json={"body": 1}), 400, "invalid"),
        (client.post("/notes", content="{", headers=headers), 400, "invalid"),
        (client.get("/notes/unknown"), 404, "not_found"),
        (client.get("/unknown"), 404, "not_found"),
    ]:
        assert response.status_code == status
        assert response.json()["error"]["code"] == code
        assert response.headers["X-Request-Id"]


def test_an_unknown_failure_hides_its_details() -> None:
    class BrokenNotes(${store}):
        def all(self) -> NoReturn:
            raise RuntimeError("secret detail")

    response = TestClient(create_app(checks=[], notes=BrokenNotes())).get("/notes")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal"
    assert "secret detail" not in response.text
    assert response.headers["X-Request-Id"] in response.text
`;

const loggerTest = (logger: string) => `import logging

${importFrom(logger, "JsonFormatter, PrettyFormatter")}


def record(message: str, **fields: object) -> logging.LogRecord:
    item = logging.LogRecord("app", logging.INFO, __file__, 1, message, None, None)
    item.__dict__.update(fields)
    return item


def test_an_http_line_is_readable_and_keeps_its_fields() -> None:
    line = PrettyFormatter(color=False).format(
        record(
            "http request",
            request_id="r",
            method="GET",
            path="/notes/1",
            route="/notes/{note_id}",
            status=200,
            duration_ms=5,
        )
    )
    assert line.endswith("INFO: GET /notes/1 200 5ms  request_id=r route=/notes/{note_id}")


def test_secrets_are_redacted_in_both_formats() -> None:
    item = record("login", password="hunter2", authorization="Bearer abc")
    for formatter in (PrettyFormatter(color=False), JsonFormatter()):
        line = formatter.format(item)
        assert "hunter2" not in line
        assert "Bearer abc" not in line
`;

function moduleFiles(name: string, errors: string, handlers: string, access: string, orm: string | undefined): Record<string, string> {
  const health = "app/modules/health", notes = "app/modules/notes";
  const errorModule = pythonModule(errors);
  const domain = pythonModule(`${notes}/domain/note`), port = pythonModule(`${notes}/domain/note_repository`);
  const repository = `from ${port} import NoteRepository`;
  const memory = `${notes}/infrastructure/persistence/memory_note_repository.py`;
  const adapter = `${notes}/infrastructure/persistence/sqlalchemy_note_repository.py`;
  const schema = `${notes}/infrastructure/persistence/schema.py`;
  const useCase = (imports: string[], body: string) => `${[...imports].sort().join("\n")}\n\n\n${body}`;
  return {
    [`${health}/domain/health.py`]: `from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal


${HEALTH_TYPES}

def to_report(checks: dict[str, bool]) -> HealthReport:
    return HealthReport("ok" if all(checks.values()) else "degraded", checks)
`,
    [`${health}/application/get_health.py`]: `import asyncio

from ${pythonModule(`${health}/domain/health`)} import HealthCheck, HealthReport, to_report

${PASSES}

async def get_health(checks: list[HealthCheck]) -> HealthReport:
    return to_report(dict(await asyncio.gather(*(passes(check) for check in checks))))
`,
    [`${health}/infrastructure/http/routes.py`]: `from fastapi import APIRouter, Request, Response

from ${pythonModule(`${health}/application/get_health`)} import get_health
from ${pythonModule(`${health}/domain/health`)} import HealthReport

router = APIRouter()


@router.get("/health")
async def health(request: Request, response: Response) -> HealthReport:
    report = await get_health(request.app.state.checks)
    if report.status != "ok":
        response.status_code = 503
    return report
`,
    [`${health}/__init__.py`]: `from ${pythonModule(`${health}/domain/health`)} import HealthCheck
from ${pythonModule(`${health}/infrastructure/http/routes`)} import router

__all__ = ["HealthCheck", "router"]
`,
    [`${notes}/domain/note.py`]: `from dataclasses import dataclass, replace
from datetime import UTC, datetime
from uuid import uuid4

from ${errorModule} import AppError


@dataclass(frozen=True)
class Note:
    id: str
    body: str
    created_at: str


def clean_body(body: str) -> str:
    """A rule of the domain: blank text is not a note."""
    clean = body.strip()
    if not clean:
        raise AppError("invalid", "A note needs some text")
    return clean


def new_note(body: str) -> Note:
    return Note(str(uuid4()), clean_body(body), datetime.now(UTC).isoformat())


def with_body(note: Note, body: str) -> Note:
    return replace(note, body=clean_body(body))
`,
    [`${notes}/domain/note_repository.py`]: `from typing import Protocol

from ${domain} import Note


class NoteRepository(Protocol):
    """The port: the domain says what it needs, and infrastructure provides it."""

    def all(self) -> list[Note]: ...

    def find(self, note_id: str) -> Note | None: ...

    def save(self, note: Note) -> None: ...

    def delete(self, note_id: str) -> bool: ...
`,
    [`${notes}/application/list_notes.py`]: useCase([`from ${domain} import Note`, repository], `def list_notes(notes: NoteRepository) -> list[Note]:
    return notes.all()
`),
    [`${notes}/application/create_note.py`]: useCase([`from ${domain} import Note, new_note`, repository], `def create_note(notes: NoteRepository, body: str) -> Note:
    note = new_note(body)
    notes.save(note)
    return note
`),
    [`${notes}/application/get_note.py`]: useCase([`from ${domain} import Note`, repository, `from ${errorModule} import AppError`], `def get_note(notes: NoteRepository, note_id: str) -> Note:
    note = notes.find(note_id)
    if note is None:
        raise AppError("not_found", "Note not found")
    return note
`),
    [`${notes}/application/update_note.py`]: useCase([`from ${pythonModule(`${notes}/application/get_note`)} import get_note`, `from ${domain} import Note, with_body`, repository], `def update_note(notes: NoteRepository, note_id: str, body: str) -> Note:
    note = with_body(get_note(notes, note_id), body)
    notes.save(note)
    return note
`),
    [`${notes}/application/delete_note.py`]: useCase([repository, `from ${errorModule} import AppError`], `def delete_note(notes: NoteRepository, note_id: str) -> None:
    if not notes.delete(note_id):
        raise AppError("not_found", "Note not found")
`),
    [`${notes}/infrastructure/http/schemas.py`]: NOTE_INPUT,
    [`${notes}/infrastructure/http/routes.py`]: noteRoutes([
      ...["create_note", "delete_note", "get_note", "list_notes", "update_note"].map((item) => `from ${pythonModule(`${notes}/application/${item}`)} import ${item}`),
      `from ${domain} import Note`, repository,
      `from ${pythonModule(`${notes}/infrastructure/http/schemas`)} import NoteInput`,
    ], "NoteRepository", { all: "list_notes", create: "create_note", get: "get_note", update: "update_note", delete: "delete_note" }),
    [memory]: `from ${domain} import Note


class MemoryNoteRepository:
    """Lost at restart: for tests, or until a database adapter of the same port takes over."""

    def __init__(self) -> None:
        self.notes: dict[str, Note] = {}

    def all(self) -> list[Note]:
        return list(self.notes.values())

    def find(self, note_id: str) -> Note | None:
        return self.notes.get(note_id)

    def save(self, note: Note) -> None:
        self.notes[note.id] = note

    def delete(self, note_id: str) -> bool:
        return self.notes.pop(note_id, None) is not None
`,
    [`${notes}/__init__.py`]: `${[
      `from ${port} import NoteRepository`,
      `from ${pythonModule(`${notes}/infrastructure/http/routes`)} import router`,
      importFrom(pythonModule(memory), "MemoryNoteRepository"),
      ...(orm ? [importFrom(pythonModule(adapter), "SqlalchemyNoteRepository")] : []),
    ].sort().join("\n")}

__all__ = [${orm ? '\n    "MemoryNoteRepository",\n    "NoteRepository",\n    "SqlalchemyNoteRepository",\n    "router",\n' : '"MemoryNoteRepository", "NoteRepository", "router"'}]
`,
    ...(orm ? {
      [schema]: noteRow(orm),
      [adapter]: sqlalchemyAdapter([`from ${domain} import Note`, `from ${pythonModule(schema)} import NoteRow`], "SqlalchemyNoteRepository"),
    } : {}),
    "app/app.py": appFile(name, [
      "from app.modules.health import HealthCheck",
      "from app.modules.health import router as health_router",
      "from app.modules.notes import NoteRepository",
      "from app.modules.notes import router as note_router",
      `from ${pythonModule(access)} import access_log`,
      importFrom(pythonModule(handlers), "register_error_handlers"),
    ], "NoteRepository"),
    "tests/test_app.py": appTest(["from app.app import create_app", "from app.modules.health import HealthCheck", "from app.modules.notes import MemoryNoteRepository"], "MemoryNoteRepository"),
  };
}

function standardFiles(name: string, errors: string, handlers: string, access: string, orm: string | undefined): Record<string, string> {
  const errorModule = pythonModule(errors);
  return {
    "app/routes/health.py": `import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from fastapi import APIRouter, Request, Response

router = APIRouter()


${HEALTH_TYPES}

${PASSES}

@router.get("/health")
async def health(request: Request, response: Response) -> HealthReport:
    results = await asyncio.gather(*(passes(check) for check in request.app.state.checks))
    checks = dict(results)
    healthy = all(checks.values())
    if not healthy:
        response.status_code = 503
    return HealthReport("ok" if healthy else "degraded", checks)
`,
    "app/schemas/notes.py": NOTE_INPUT,
    "app/services/notes.py": `from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Protocol
from uuid import uuid4

from ${errorModule} import AppError


@dataclass(frozen=True)
class Note:
    id: str
    body: str
    created_at: str


class NoteStore(Protocol):
    def all(self) -> list[Note]: ...

    def find(self, note_id: str) -> Note | None: ...

    def save(self, note: Note) -> None: ...

    def delete(self, note_id: str) -> bool: ...


class MemoryNoteStore:
    """Lost at restart: for tests, or until a database store takes over."""

    def __init__(self) -> None:
        self.notes: dict[str, Note] = {}

    def all(self) -> list[Note]:
        return list(self.notes.values())

    def find(self, note_id: str) -> Note | None:
        return self.notes.get(note_id)

    def save(self, note: Note) -> None:
        self.notes[note.id] = note

    def delete(self, note_id: str) -> bool:
        return self.notes.pop(note_id, None) is not None


def clean_body(body: str) -> str:
    clean = body.strip()
    if not clean:
        raise AppError("invalid", "A note needs some text")
    return clean


def list_notes(notes: NoteStore) -> list[Note]:
    return notes.all()


def get_note(notes: NoteStore, note_id: str) -> Note:
    note = notes.find(note_id)
    if note is None:
        raise AppError("not_found", "Note not found")
    return note


def create_note(notes: NoteStore, body: str) -> Note:
    note = Note(str(uuid4()), clean_body(body), datetime.now(UTC).isoformat())
    notes.save(note)
    return note


def update_note(notes: NoteStore, note_id: str, body: str) -> Note:
    note = replace(get_note(notes, note_id), body=clean_body(body))
    notes.save(note)
    return note


def delete_note(notes: NoteStore, note_id: str) -> None:
    if not notes.delete(note_id):
        raise AppError("not_found", "Note not found")
`,
    ...(orm ? {
      "app/lib/schema.py": noteRow(orm),
      "app/services/sqlalchemy_note_store.py": sqlalchemyAdapter(["from app.lib.schema import NoteRow", "from app.services.notes import Note"], "SqlalchemyNoteStore"),
    } : {}),
    "app/routes/notes.py": noteRoutes([
      "from app.schemas.notes import NoteInput",
      "from app.services.notes import (\n    Note,\n    NoteStore,\n    create_note,\n    delete_note,\n    get_note,\n    list_notes,\n    update_note,\n)",
    ], "NoteStore", { all: "list_notes", create: "create_note", get: "get_note", update: "update_note", delete: "delete_note" }),
    "app/app.py": appFile(name, [
      "from app.routes.health import HealthCheck",
      "from app.routes.health import router as health_router",
      "from app.routes.notes import router as note_router",
      "from app.services.notes import NoteStore",
      `from ${pythonModule(access)} import access_log`,
      importFrom(pythonModule(handlers), "register_error_handlers"),
    ], "NoteStore"),
    "tests/test_app.py": appTest(["from app.app import create_app", "from app.routes.health import HealthCheck", "from app.services.notes import MemoryNoteStore"], "MemoryNoteStore"),
  };
}

/** The FastAPI application itself: one layout per code structure, with the same behavior. */
export function fastapiFiles(name: string, modules: boolean, orm: boolean): Record<string, string> {
  const lib = modules ? "app/shared/infrastructure" : "app/lib";
  const http = modules ? `${lib}/http` : "app/middleware";
  const errors = modules ? "app/shared/domain/errors.py" : "app/lib/errors.py";
  const logger = `${lib}/logger.py`, access = `${http}/access_log.py`, handlers = `${http}/error_handlers.py`;
  const base = orm ? pythonModule(`${lib}/orm`) : undefined;
  return {
    [errors]: ERRORS,
    [logger]: LOGGER,
    [access]: ACCESS_LOG,
    [handlers]: errorHandlers(pythonModule(errors)),
    "tests/test_logger.py": loggerTest(pythonModule(logger)),
    ...(modules ? moduleFiles : standardFiles)(name, errors, handlers, access, base),
  };
}
