from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from datetime import date
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import threading
import time
import uuid
import psycopg2
from psycopg2.extras import RealDictCursor

from scoring import calculate_measurement_score
from batch_rating import load_bundle, scores as bulk_scores, ratings as bulk_ratings

MATRIX = json.loads((Path(__file__).with_name("matrix_v0_2.json")).read_text(encoding="utf-8"))

ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH", "")
ADMIN_SESSION_SECRET = os.getenv("ADMIN_SESSION_SECRET", "")
ADMIN_SESSION_TTL = int(os.getenv("ADMIN_SESSION_TTL", str(8 * 60 * 60)))
ADMIN_COOKIE_NAME = "school22_admin_session"
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() == "true"
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 5
LOGIN_BLOCK_SECONDS = 15 * 60
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

_login_lock = threading.Lock()
_login_attempts: dict[str, list[float]] = {}
_login_blocked_until: dict[str, float] = {}


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _password_matches(password: str) -> bool:
    try:
        scheme, iterations_text, salt_text, digest_text = ADMIN_PASSWORD_HASH.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        iterations = int(iterations_text)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            _b64decode(salt_text),
            iterations,
            dklen=32,
        )
        return hmac.compare_digest(actual, _b64decode(digest_text))
    except (TypeError, ValueError):
        return False


def _sign_session() -> str:
    now = int(time.time())
    payload = json.dumps(
        {
            "version": 1,
            "issued_at": now,
            "expires_at": now + ADMIN_SESSION_TTL,
            "nonce": secrets.token_urlsafe(12),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    encoded = _b64encode(payload)
    signature = hmac.new(
        ADMIN_SESSION_SECRET.encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{encoded}.{_b64encode(signature)}"


def _verify_session(token: Optional[str]) -> bool:
    if not token or not ADMIN_SESSION_SECRET:
        return False
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected_signature = hmac.new(
            ADMIN_SESSION_SECRET.encode("utf-8"),
            encoded.encode("ascii"),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(expected_signature, _b64decode(supplied_signature)):
            return False
        payload = json.loads(_b64decode(encoded))
        return payload.get("version") == 1 and int(payload.get("expires_at", 0)) > int(time.time())
    except (ValueError, TypeError, json.JSONDecodeError):
        return False


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    address = forwarded.split(",", 1)[0].strip() if forwarded else ""
    if not address and request.client:
        address = request.client.host
    return hashlib.sha256(address.encode("utf-8")).hexdigest()


def _login_is_blocked(client_key: str) -> tuple[bool, int]:
    now = time.time()
    with _login_lock:
        blocked_until = _login_blocked_until.get(client_key, 0)
        if blocked_until > now:
            return True, max(1, int(blocked_until - now))
        attempts = [
            timestamp
            for timestamp in _login_attempts.get(client_key, [])
            if timestamp > now - LOGIN_WINDOW_SECONDS
        ]
        _login_attempts[client_key] = attempts
        return False, 0


def _record_failed_login(client_key: str) -> None:
    now = time.time()
    with _login_lock:
        attempts = [
            timestamp
            for timestamp in _login_attempts.get(client_key, [])
            if timestamp > now - LOGIN_WINDOW_SECONDS
        ]
        attempts.append(now)
        _login_attempts[client_key] = attempts
        if len(attempts) >= LOGIN_MAX_ATTEMPTS:
            _login_blocked_until[client_key] = now + LOGIN_BLOCK_SECONDS
            _login_attempts[client_key] = []


def _clear_failed_logins(client_key: str) -> None:
    with _login_lock:
        _login_attempts.pop(client_key, None)
        _login_blocked_until.pop(client_key, None)


def _requires_admin(request: Request) -> bool:
    path = request.url.path.rstrip("/")
    if path.startswith("/api/auth"):
        return False
    return request.method in WRITE_METHODS and path.startswith(("/api/", "/v2/api/"))


def _write_audit_log(method, path, status_code, request_id):
    print(json.dumps({"event":"admin_write", "method":method,"path":path,"status":status_code,"request_id":request_id}))


app = FastAPI(
    title="School 22 Rating API",
    version="0.4.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv(
            "ALLOWED_ORIGINS",
            "https://school22-rating-site.vercel.app,https://school22-admin.vercel.app",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Requested-With"],
)


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    request_id = str(uuid.uuid4())
    if _requires_admin(request) and not _verify_session(request.cookies.get(ADMIN_COOKIE_NAME)):
        return JSONResponse(
            status_code=401,
            content={"detail": "Требуется вход в админ-панель"},
            headers={"Cache-Control": "no-store", "X-Request-ID": request_id},
        )

    if request.method in WRITE_METHODS:
        origin = request.headers.get("origin")
        if origin and origin not in {"https://school22-admin.vercel.app", "https://school22-rating-site.vercel.app"}:
            return JSONResponse(status_code=403,content={"detail":"Недопустимый источник запроса"})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["X-Request-ID"] = request_id
    if request.url.path.startswith("/api/auth"):
        response.headers["Cache-Control"] = "no-store"

    if (
        request.method in WRITE_METHODS
        and request.url.path.startswith(("/api/", "/v2/api/"))
        and not request.url.path.startswith("/api/auth")
    ):
        _write_audit_log(request.method, request.url.path, response.status_code, request_id)
    return response


def db():
    return psycopg2.connect(
        host=os.getenv("RATING_DB_HOST", "aws-0-eu-central-1.pooler.supabase.com"),
        port=6543, dbname="postgres", user="rating_server.topossrhzffwypzpnsqp",
        password=os.environ["RATING_DB_PASSWORD"], sslmode="require", connect_timeout=8,
        cursor_factory=RealDictCursor,
    )

@app.get("/api/health")
def health():
    try:
        connection = db()
    except Exception as error:
        print("database_connection_failed", type(error).__name__, str(error))
        return JSONResponse(status_code=503,content={"status":"unavailable","code":"DB_AUTH" if "password authentication" in str(error) else "DB_ENDPOINT" if "Tenant or user not found" in str(error) else "DB_POOLER_CONFIG" if "unsupported" in str(error).lower() else "DB_TIMEOUT" if "timeout" in str(error).lower() else "DB_DNS" if "translate host" in str(error).lower() else "DB_NETWORK"})
    try:
        with connection.cursor() as cursor:
            cursor.execute("select count(*) as n from classes where status='active'")
            return {"status":"ok","database":"postgres","classes":cursor.fetchone()["n"]}
    finally:
        connection.close()


class ClassCreate(BaseModel):
    name: str
    grade: int
    group_id: int
    students_count: int = 0


class ClassUpdate(BaseModel):
    name: Optional[str] = None
    grade: Optional[int] = None
    group_id: Optional[int] = None
    students_count: Optional[int] = None
    status: Optional[str] = None


class CategoryCreate(BaseModel):
    name: str
    max_points: int = 100
    sort_order: int = 0


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    max_points: Optional[int] = None
    sort_order: Optional[int] = None
    status: Optional[str] = None


class SubcategoryCreate(BaseModel):
    category_id: int
    name: str
    max_points: int = 10
    sort_order: int = 0
    code: Optional[str] = None
    formula_code: Optional[str] = None
    target: Optional[float] = None
    unit: Optional[str] = None
    measurement: Optional[str] = None
    scoring_rule: Optional[str] = None
    periodicity: Optional[str] = None


class SubcategoryUpdate(BaseModel):
    category_id: Optional[int] = None
    name: Optional[str] = None
    max_points: Optional[int] = None
    sort_order: Optional[int] = None
    status: Optional[str] = None
    code: Optional[str] = None
    formula_code: Optional[str] = None
    target: Optional[float] = None
    unit: Optional[str] = None
    measurement: Optional[str] = None
    scoring_rule: Optional[str] = None
    periodicity: Optional[str] = None


class FormulaCalculation(BaseModel):
    subcategory_id: int
    input_data: dict = {}


class ClassCategoryScoreUpdate(BaseModel):
    points: float
    comment: Optional[str] = None


class ClassSubcategoryScoreUpdate(BaseModel):
    points: float
    comment: Optional[str] = None


class SubcategoryEventCreate(BaseModel):
    subcategory_id: int
    event_date: str
    title: str
    points: float
    comment: Optional[str] = None


class SubcategoryEventUpdate(BaseModel):
    subcategory_id: Optional[int] = None
    event_date: Optional[str] = None
    title: Optional[str] = None
    points: Optional[float] = None
    comment: Optional[str] = None


class UniformCheckCreate(BaseModel):
    check_date: str
    without_uniform: int
    comment: Optional[str] = None


class UniformCheckUpdate(BaseModel):
    check_date: Optional[str] = None
    without_uniform: Optional[int] = None
    comment: Optional[str] = None


class LoginRequest(BaseModel):
    password: str


@app.post("/api/auth/login")
def login(item: LoginRequest, request: Request):
    if not ADMIN_PASSWORD_HASH or not ADMIN_SESSION_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Защита админ-панели ещё не настроена на сервере",
        )
    if not item.password or len(item.password) > 256:
        raise HTTPException(status_code=401, detail="Неверный пароль")

    client_key = _client_key(request)
    blocked, retry_after = _login_is_blocked(client_key)
    if blocked:
        return JSONResponse(
            status_code=429,
            content={"detail": "Слишком много попыток. Повторите вход позже."},
            headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
        )

    if not _password_matches(item.password):
        _record_failed_login(client_key)
        raise HTTPException(status_code=401, detail="Неверный пароль")

    _clear_failed_logins(client_key)
    response = JSONResponse({"authenticated": True, "expires_in": ADMIN_SESSION_TTL})
    response.set_cookie(
        key=ADMIN_COOKIE_NAME,
        value=_sign_session(),
        max_age=ADMIN_SESSION_TTL,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/auth/me")
def auth_status(request: Request):
    return {"authenticated": _verify_session(request.cookies.get(ADMIN_COOKIE_NAME))}


@app.post("/api/auth/logout")
def logout():
    response = JSONResponse({"authenticated": False})
    response.delete_cookie(
        key=ADMIN_COOKIE_NAME,
        path="/",
        secure=COOKIE_SECURE,
        httponly=True,
        samesite="strict",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def home():
    return {
        "message": "API рейтинга Школы №22 работает на Supabase PostgreSQL",
        "security": "write operations require an authenticated admin session"
    }


@app.get("/api/groups")
def get_groups():
    connection = db()
    cursor = connection.cursor()
    cursor.execute("SELECT * FROM school_groups ORDER BY id")
    rows = cursor.fetchall()
    cursor.close()
    connection.close()
    return rows


@app.get("/api/classes")
def get_classes():
    connection = db()
    cursor = connection.cursor()
    cursor.execute("""
        SELECT classes.*, school_groups.name AS group_name
        FROM classes
        JOIN school_groups ON school_groups.id = classes.group_id
        WHERE classes.status = 'active'
        ORDER BY classes.grade, classes.name
    """)
    rows = cursor.fetchall()
    cursor.close()
    connection.close()
    return rows


@app.post("/api/classes")
def create_class(item: ClassCreate):
    connection = db()
    cursor = connection.cursor()
    cursor.execute(
        """
        INSERT INTO classes (name, grade, group_id, students_count)
        VALUES (%s, %s, %s, %s)
        RETURNING id
        """,
        (item.name, item.grade, item.group_id, item.students_count),
    )
    class_id = cursor.fetchone()["id"]
    connection.commit()
    cursor.close()
    connection.close()
    return {"id": class_id, "message": "Класс добавлен"}


@app.put("/api/classes/{class_id}")
def update_class(class_id: int, item: ClassUpdate):
    fields = []
    values = []

    for key, value in item.dict(exclude_unset=True).items():
        fields.append(f"{key} = %s")
        values.append(value)

    if not fields:
        return {"message": "Нет изменений"}

    values.append(class_id)
    connection = db()
    cursor = connection.cursor()
    cursor.execute(f"UPDATE classes SET {', '.join(fields)} WHERE id = %s", values)
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Класс обновлён"}


@app.delete("/api/classes/{class_id}")
def delete_class(class_id: int):
    connection = db()
    cursor = connection.cursor()
    cursor.execute("UPDATE classes SET status = 'archive' WHERE id = %s", (class_id,))
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Класс удалён в архив"}


@app.get("/api/categories")
def get_categories():
    connection = db()
    cursor = connection.cursor()
    cursor.execute("""
        SELECT *
        FROM categories
        WHERE status = 'active'
        ORDER BY sort_order, id
    """)
    categories = cursor.fetchall()

    result = []
    for category in categories:
        cursor.execute("""
            SELECT *
            FROM subcategories
            WHERE category_id = %s AND status = 'active'
            ORDER BY sort_order, id
        """, (category["id"],))
        item = dict(category)
        item["subcategories"] = cursor.fetchall()
        result.append(item)

    cursor.close()
    connection.close()
    return result


@app.post("/api/categories")
def create_category(category: CategoryCreate):
    connection = db()
    cursor = connection.cursor()
    cursor.execute(
        """
        INSERT INTO categories (name, max_points, sort_order)
        VALUES (%s, %s, %s)
        RETURNING id
        """,
        (category.name, category.max_points, category.sort_order),
    )
    category_id = cursor.fetchone()["id"]
    connection.commit()
    cursor.close()
    connection.close()
    return {"id": category_id, "message": "Категория добавлена"}


@app.put("/api/categories/{category_id}")
def update_category(category_id: int, category: CategoryUpdate):
    fields = []
    values = []

    for key, value in category.dict(exclude_unset=True).items():
        fields.append(f"{key} = %s")
        values.append(value)

    if not fields:
        return {"message": "Нет изменений"}

    values.append(category_id)
    connection = db()
    cursor = connection.cursor()
    cursor.execute(f"UPDATE categories SET {', '.join(fields)} WHERE id = %s", values)
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Категория обновлена"}


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: int):
    connection = db()
    cursor = connection.cursor()
    cursor.execute("UPDATE categories SET status = 'archive' WHERE id = %s", (category_id,))
    cursor.execute("UPDATE subcategories SET status = 'archive' WHERE category_id = %s", (category_id,))
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Категория удалена в архив"}


@app.post("/api/subcategories")
def create_subcategory(subcategory: SubcategoryCreate):
    connection = db()
    cursor = connection.cursor()
    cursor.execute(
        """
        INSERT INTO subcategories (
            category_id, name, max_points, sort_order, code, formula_code,
            target, unit, measurement, scoring_rule, periodicity
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            subcategory.category_id,
            subcategory.name,
            subcategory.max_points,
            subcategory.sort_order,
            subcategory.code,
            subcategory.formula_code,
            subcategory.target,
            subcategory.unit,
            subcategory.measurement,
            subcategory.scoring_rule,
            subcategory.periodicity,
        ),
    )
    subcategory_id = cursor.fetchone()["id"]
    connection.commit()
    cursor.close()
    connection.close()
    return {"id": subcategory_id, "message": "Подкатегория добавлена"}


@app.put("/api/subcategories/{subcategory_id}")
def update_subcategory(subcategory_id: int, subcategory: SubcategoryUpdate):
    fields = []
    values = []

    for key, value in subcategory.dict(exclude_unset=True).items():
        fields.append(f"{key} = %s")
        values.append(value)

    if not fields:
        return {"message": "Нет изменений"}

    values.append(subcategory_id)
    connection = db()
    cursor = connection.cursor()
    cursor.execute(f"UPDATE subcategories SET {', '.join(fields)} WHERE id = %s", values)
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Подкатегория обновлена"}


@app.delete("/api/subcategories/{subcategory_id}")
def delete_subcategory(subcategory_id: int):
    connection = db()
    cursor = connection.cursor()
    cursor.execute("UPDATE subcategories SET status = 'archive' WHERE id = %s", (subcategory_id,))
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Подкатегория удалена в архив"}


@app.post("/api/calculate-score")
def calculate_formula_score(item: FormulaCalculation):
    connection = db()
    cursor = connection.cursor()
    cursor.execute(
        """
        SELECT formula_code, target
        FROM subcategories
        WHERE id = %s AND status = 'active'
        """,
        (item.subcategory_id,),
    )
    criterion = cursor.fetchone()
    cursor.close()
    connection.close()

    if not criterion:
        raise HTTPException(status_code=404, detail="Критерий не найден")
    if not criterion.get("formula_code"):
        raise HTTPException(status_code=400, detail="У критерия не задана формула")

    try:
        points = calculate_measurement_score(criterion, item.input_data)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return {"points": points, "formula_code": criterion["formula_code"]}


@app.put("/api/classes/{class_id}/category-scores/{category_id}")
def set_class_category_score(class_id: int, category_id: int, score: ClassCategoryScoreUpdate):
    connection = db()
    cursor = connection.cursor()

    cursor.execute(
        "SELECT * FROM categories WHERE id = %s AND status = 'active'",
        (category_id,)
    )
    category = cursor.fetchone()

    if not category:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=404, detail="Категория не найдена")

    if score.points < 0 or score.points > category["max_points"]:
        cursor.close()
        connection.close()
        raise HTTPException(
            status_code=400,
            detail=f"Баллы должны быть от 0 до {category['max_points']}"
        )

    cursor.execute("""
        INSERT INTO class_category_scores (class_id, category_id, points, comment, updated_at)
        VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
        ON CONFLICT(class_id, category_id)
        DO UPDATE SET
            points = EXCLUDED.points,
            comment = EXCLUDED.comment,
            updated_at = CURRENT_TIMESTAMP
    """, (class_id, category_id, score.points, score.comment))

    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Баллы класса по категории сохранены"}


@app.put("/api/classes/{class_id}/subcategory-scores/{subcategory_id}")
def set_class_subcategory_score(class_id: int, subcategory_id: int, score: ClassSubcategoryScoreUpdate):
    connection = db()
    cursor = connection.cursor()

    cursor.execute(
        "SELECT * FROM subcategories WHERE id = %s AND status = 'active'",
        (subcategory_id,)
    )
    subcategory = cursor.fetchone()

    if not subcategory:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=404, detail="Подкатегория не найдена")

    if score.points < 0 or score.points > subcategory["max_points"]:
        cursor.close()
        connection.close()
        raise HTTPException(
            status_code=400,
            detail=f"Баллы должны быть от 0 до {subcategory['max_points']}"
        )

    cursor.execute("""
        INSERT INTO class_subcategory_scores (class_id, subcategory_id, points, comment, updated_at)
        VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)
        ON CONFLICT(class_id, subcategory_id)
        DO UPDATE SET
            points = EXCLUDED.points,
            comment = EXCLUDED.comment,
            updated_at = CURRENT_TIMESTAMP
    """, (class_id, subcategory_id, score.points, score.comment))

    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Баллы класса по подкатегории сохранены"}


@app.post("/api/classes/{class_id}/subcategory-events")
def create_subcategory_event(class_id: int, item: SubcategoryEventCreate):
    connection = db()
    cursor = connection.cursor()

    cursor.execute("SELECT * FROM classes WHERE id = %s AND status = 'active'", (class_id,))
    class_row = cursor.fetchone()

    if not class_row:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=404, detail="Класс не найден")

    cursor.execute("SELECT * FROM subcategories WHERE id = %s AND status = 'active'", (item.subcategory_id,))
    subcategory = cursor.fetchone()

    if not subcategory:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=404, detail="Подкатегория не найдена")

    if item.points < 0:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=400, detail="Баллы не могут быть меньше 0")

    cursor.execute("""
        INSERT INTO class_subcategory_events (class_id, subcategory_id, event_date, title, points, comment)
        VALUES (%s, %s, %s, %s, %s, %s)
        RETURNING id
    """, (class_id, item.subcategory_id, item.event_date, item.title, item.points, item.comment))

    event_id = cursor.fetchone()["id"]
    connection.commit()
    cursor.close()
    connection.close()
    return {"id": event_id, "message": "Событие добавлено"}


@app.get("/api/classes/{class_id}/subcategory-events")
def get_class_subcategory_events(class_id: int):
    connection = db()
    cursor = connection.cursor()

    cursor.execute("""
        SELECT
            class_subcategory_events.*,
            subcategories.name AS subcategory_name,
            categories.name AS category_name,
            subcategories.max_points AS subcategory_max_points
        FROM class_subcategory_events
        JOIN subcategories ON subcategories.id = class_subcategory_events.subcategory_id
        JOIN categories ON categories.id = subcategories.category_id
        WHERE class_subcategory_events.class_id = %s
        ORDER BY class_subcategory_events.event_date DESC, class_subcategory_events.id DESC
    """, (class_id,))

    rows = cursor.fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["event_date"] = str(item["event_date"])
        item["created_at"] = str(item["created_at"])
        result.append(item)

    cursor.close()
    connection.close()
    return result


@app.put("/api/subcategory-events/{event_id}")
def update_subcategory_event(event_id: int, item: SubcategoryEventUpdate):
    fields = []
    values = []

    for key, value in item.dict(exclude_unset=True).items():
        fields.append(f"{key} = %s")
        values.append(value)

    if not fields:
        return {"message": "Нет изменений"}

    values.append(event_id)
    connection = db()
    cursor = connection.cursor()
    cursor.execute(
        f"UPDATE class_subcategory_events SET {', '.join(fields)} WHERE id = %s",
        values
    )
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Событие обновлено"}


@app.delete("/api/subcategory-events/{event_id}")
def delete_subcategory_event(event_id: int):
    connection = db()
    cursor = connection.cursor()
    cursor.execute("DELETE FROM class_subcategory_events WHERE id = %s", (event_id,))
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Событие удалено"}


@app.get("/api/classes/{class_id}/category-scores")
def get_class_category_scores(class_id: int):
    connection = db()
    result = build_class_category_scores(connection, class_id)
    connection.close()
    return result


@app.post("/api/classes/{class_id}/uniform-checks")
def create_uniform_check(class_id: int, item: UniformCheckCreate):
    connection = db()
    cursor = connection.cursor()

    cursor.execute("SELECT * FROM classes WHERE id = %s", (class_id,))
    class_row = cursor.fetchone()

    if not class_row:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=404, detail="Класс не найден")

    if item.without_uniform < 0:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=400, detail="Количество без формы не может быть меньше 0")

    if item.without_uniform > class_row["students_count"]:
        cursor.close()
        connection.close()
        raise HTTPException(
            status_code=400,
            detail="Количество без формы не может быть больше количества учеников в классе"
        )

    cursor.execute("""
        INSERT INTO uniform_checks (class_id, check_date, without_uniform, comment)
        VALUES (%s, %s, %s, %s)
        RETURNING id
    """, (class_id, item.check_date, item.without_uniform, item.comment))

    check_id = cursor.fetchone()["id"]
    connection.commit()
    cursor.close()
    connection.close()
    return {"id": check_id, "message": "Проверка формы добавлена"}


@app.get("/api/classes/{class_id}/uniform-checks")
def get_uniform_checks(class_id: int):
    connection = db()
    result = build_uniform_checks(connection, class_id)
    connection.close()
    return result


@app.put("/api/uniform-checks/{check_id}")
def update_uniform_check(check_id: int, item: UniformCheckUpdate):
    connection = db()
    cursor = connection.cursor()

    cursor.execute("SELECT * FROM uniform_checks WHERE id = %s", (check_id,))
    check = cursor.fetchone()

    if not check:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=404, detail="Проверка не найдена")

    cursor.execute("SELECT * FROM classes WHERE id = %s", (check["class_id"],))
    class_row = cursor.fetchone()

    fields = []
    values = []

    for key, value in item.dict(exclude_unset=True).items():
        if key == "without_uniform" and value > class_row["students_count"]:
            cursor.close()
            connection.close()
            raise HTTPException(
                status_code=400,
                detail="Количество без формы не может быть больше количества учеников в классе"
            )

        fields.append(f"{key} = %s")
        values.append(value)

    if not fields:
        cursor.close()
        connection.close()
        return {"message": "Нет изменений"}

    values.append(check_id)
    cursor.execute(f"UPDATE uniform_checks SET {', '.join(fields)} WHERE id = %s", values)
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Проверка формы обновлена"}


@app.delete("/api/uniform-checks/{check_id}")
def delete_uniform_check(check_id: int):
    connection = db()
    cursor = connection.cursor()
    cursor.execute("DELETE FROM uniform_checks WHERE id = %s", (check_id,))
    connection.commit()
    cursor.close()
    connection.close()
    return {"message": "Проверка формы удалена"}


@app.get("/api/ratings/groups/{group_id}")
def get_group_rating(group_id: int):
    connection = db()
    try:
        return bulk_ratings(connection,format_uniform_check,group_id)
    finally:
        connection.close()


@app.get("/api/ratings/classes")
def get_all_classes_rating():
    connection = db()
    try:
        return bulk_ratings(connection,format_uniform_check)
    finally:
        connection.close()


@app.get("/api/classes/{class_id}/details")
def get_class_details(class_id: int):
    connection = db()
    cursor = connection.cursor()

    cursor.execute("SELECT * FROM classes WHERE id = %s", (class_id,))
    class_row = cursor.fetchone()

    if not class_row:
        cursor.close()
        connection.close()
        raise HTTPException(status_code=404, detail="Класс не найден")

    result = {
        "class": calculate_class_rating(connection, class_row),
        "category_scores": build_class_category_scores(connection, class_id),
        "uniform": build_uniform_checks(connection, class_id),
        "events": get_class_events_internal(connection, class_id)
    }

    cursor.close()
    connection.close()
    return result


def get_class_events_internal(connection, class_id: int):
    cursor = connection.cursor()
    cursor.execute("""
        SELECT
            class_subcategory_events.*,
            subcategories.name AS subcategory_name,
            categories.name AS category_name,
            subcategories.max_points AS subcategory_max_points
        FROM class_subcategory_events
        JOIN subcategories ON subcategories.id = class_subcategory_events.subcategory_id
        JOIN categories ON categories.id = subcategories.category_id
        WHERE class_subcategory_events.class_id = %s
        ORDER BY class_subcategory_events.event_date DESC, class_subcategory_events.id DESC
    """, (class_id,))

    rows = cursor.fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["event_date"] = str(item["event_date"])
        item["created_at"] = str(item["created_at"])
        result.append(item)

    cursor.close()
    return result


def build_class_category_scores(connection, class_id: int):
    data = load_bundle(connection)
    cls = next((r for r in data["classes"] if r["id"] == class_id),None)
    if cls is None:
        raise HTTPException(status_code=404,detail="Класс не найден")
    return bulk_scores(data,cls,format_uniform_check)


def build_uniform_checks(connection, class_id: int):
    cursor = connection.cursor()

    cursor.execute("SELECT * FROM classes WHERE id = %s", (class_id,))
    class_row = cursor.fetchone()

    if not class_row:
        cursor.close()
        return {
            "class_id": class_id,
            "students_count": 0,
            "average_points": 0,
            "checks_count": 0,
            "is_checked_current_month": False,
            "latest_check_date": None,
            "checks": []
        }

    cursor.execute("""
        SELECT *
        FROM uniform_checks
        WHERE class_id = %s
        ORDER BY check_date DESC, id DESC
    """, (class_id,))

    checks = cursor.fetchall()
    result = [format_uniform_check(class_row, check) for check in checks]
    summary = calculate_uniform_summary(connection, class_id)

    today = date.today()
    latest_check_date = result[0]["check_date"] if result else None
    is_checked_current_month = False

    if latest_check_date:
        year, month, *_ = latest_check_date.split("-")
        is_checked_current_month = int(year) == today.year and int(month) == today.month

    cursor.close()

    return {
        "class_id": class_id,
        "class_name": class_row["name"],
        "students_count": class_row["students_count"],
        "average_points": summary["average_points"],
        "checks_count": summary["checks_count"],
        "is_checked_current_month": is_checked_current_month,
        "latest_check_date": latest_check_date,
        "checks": result
    }


def calculate_class_rating(connection, class_row):
    category_scores = build_class_category_scores(connection, class_row["id"])
    earned = sum(float(row["points"] or 0) for row in category_scores)
    possible = sum(float(row["max_points"] or 0) for row in category_scores)
    total = (earned / possible * 100) if possible else 0

    return {
        "class_id": class_row["id"],
        "class_name": class_row["name"],
        "grade": class_row["grade"],
        "group_id": class_row["group_id"],
        "students_count": class_row["students_count"],
        "total": round(total, 2),
        "categories": category_scores
    }


def calculate_uniform_summary(connection, class_id: int):
    cursor = connection.cursor()

    cursor.execute("SELECT * FROM classes WHERE id = %s", (class_id,))
    class_row = cursor.fetchone()

    if not class_row:
        cursor.close()
        return {
            "average_points": 0,
            "checks_count": 0,
            "is_checked_current_month": False,
            "latest_check_date": None,
            "checks": []
        }

    cursor.execute("""
        SELECT *
        FROM uniform_checks
        WHERE class_id = %s
        ORDER BY check_date DESC, id DESC
    """, (class_id,))

    checks = cursor.fetchall()

    if not checks:
        cursor.close()
        return {
            "average_points": 0,
            "checks_count": 0,
            "is_checked_current_month": False,
            "latest_check_date": None,
            "checks": []
        }

    formatted = [format_uniform_check(class_row, check) for check in checks]
    average = sum(item["points"] for item in formatted) / len(formatted)

    today = date.today()
    latest_check_date = formatted[0]["check_date"]
    year, month, *_ = latest_check_date.split("-")
    is_checked_current_month = int(year) == today.year and int(month) == today.month

    cursor.close()

    return {
        "average_points": round(average, 2),
        "checks_count": len(formatted),
        "is_checked_current_month": is_checked_current_month,
        "latest_check_date": latest_check_date,
        "checks": formatted
    }


def format_uniform_check(class_row, check):
    students_count = class_row["students_count"]
    without_uniform = check["without_uniform"]
    in_uniform = max(students_count - without_uniform, 0)

    if students_count <= 0:
        percent_in_uniform = 0
    else:
        percent_in_uniform = round((in_uniform / students_count) * 100, 2)

    points = uniform_points(percent_in_uniform)

    return {
        "id": check["id"],
        "class_id": check["class_id"],
        "check_date": str(check["check_date"]),
        "students_count": students_count,
        "without_uniform": without_uniform,
        "in_uniform": in_uniform,
        "percent_in_uniform": percent_in_uniform,
        "points": points,
        "comment": check["comment"],
        "created_at": str(check["created_at"])
    }


def uniform_points(percent: float) -> int:
    if percent >= 100:
        return 10
    if percent >= 80:
        return 8
    if percent >= 60:
        return 5
    if percent >= 40:
        return 2
    if percent >= 20:
        return 0
    return 0


