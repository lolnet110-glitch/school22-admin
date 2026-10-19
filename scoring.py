from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping


FORMULA_CODES = {
    "ОХВ(T)",
    "КОЛ(q)",
    "СРЕЗ",
    "ФАКТ",
    "ИНД",
    "КГ/УЧ(T)",
}


def _number(value: Any, field: str, *, default: float | None = None) -> float:
    if value is None or value == "":
        if default is not None:
            return default
        raise ValueError(f"Поле «{field}» обязательно")
    try:
        result = float(Decimal(str(value)))
    except (InvalidOperation, TypeError, ValueError) as error:
        raise ValueError(f"Поле «{field}» должно быть числом") from error
    if result < 0:
        raise ValueError(f"Поле «{field}» не может быть отрицательным")
    return result


def _clamp_score(value: float) -> float:
    return round(max(0.0, min(10.0, value)), 2)


def calculate_measurement_score(
    criterion: Mapping[str, Any],
    input_data: Mapping[str, Any] | None,
) -> float:
    data = input_data or {}
    formula_code = criterion["formula_code"]
    target = _number(criterion.get("target"), "цель", default=0)

    if formula_code not in FORMULA_CODES:
        raise ValueError(f"Неизвестная формула: {formula_code}")

    if formula_code == "ОХВ(T)":
        if data.get("percent") not in (None, ""):
            percent = _number(data.get("percent"), "процент")
        else:
            numerator = _number(data.get("numerator"), "охвачено")
            denominator = _number(data.get("denominator"), "знаменатель")
            percent = 0 if denominator == 0 else numerator / denominator * 100
        if target <= 0:
            return 0.0
        return _clamp_score(10 * percent / target)

    if formula_code == "КОЛ(q)":
        quantity = _number(data.get("quantity"), "количество")
        if target <= 0:
            return 0.0
        return _clamp_score(10 * quantity / target)

    if formula_code == "СРЕЗ":
        present = _number(data.get("present"), "присутствуют")
        violations = _number(data.get("violations"), "нарушения")
        if present == 0:
            return 0.0
        if violations > present:
            raise ValueError("Нарушений не может быть больше присутствующих")
        return _clamp_score(10 * (present - violations) / present)

    if formula_code == "ФАКТ":
        fact_score = _number(data.get("fact_score"), "уровень выполнения")
        if fact_score not in {0, 5, 10}:
            raise ValueError("Для формулы «ФАКТ» допустимы только 0, 5 или 10 баллов")
        return fact_score

    if formula_code == "ИНД":
        school = _number(data.get("school"), "школьный уровень", default=0)
        municipal = _number(data.get("municipal"), "муниципальный уровень", default=0)
        regional = _number(data.get("regional"), "региональный уровень", default=0)
        federal = _number(data.get("federal"), "федеральный/международный уровень", default=0)
        return _clamp_score(school + 2 * municipal + 3 * regional + 4 * federal)

    amount = _number(data.get("amount"), "объём")
    denominator = _number(data.get("denominator"), "численность")
    if denominator == 0 or target <= 0:
        return 0.0
    return _clamp_score(10 * (amount / denominator) / target)


def aggregate_measurements(
    criterion: Mapping[str, Any],
    measurements: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    ordered = sorted(
        measurements,
        key=lambda item: (
            str(item.get("measured_at") or ""),
            int(item.get("id") or 0),
        ),
    )

    if not ordered:
        return {
            "points": 0.0,
            "applicable": True,
            "completed": False,
            "measurement_count": 0,
        }

    latest = ordered[-1]
    if latest.get("is_not_applicable"):
        return {
            "points": None,
            "applicable": False,
            "completed": True,
            "measurement_count": len(ordered),
        }

    applicable = [item for item in ordered if not item.get("is_not_applicable")]
    scores = [
        calculate_measurement_score(criterion, item.get("input_data") or {})
        for item in applicable
    ]

    if not scores:
        points = 0.0
    elif criterion.get("aggregation") == "average":
        points = round(sum(scores) / len(scores), 2)
    else:
        points = scores[-1]

    return {
        "points": points,
        "applicable": True,
        "completed": bool(scores),
        "measurement_count": len(ordered),
    }


def aggregate_responsibility_checks(
    checks: Iterable[Mapping[str, Any]],
    violation_field: str,
) -> dict[str, Any]:
    scores = []
    rows = list(checks)
    for check in rows:
        present = _number(check.get("present_count"), "присутствуют", default=0)
        violations = _number(check.get(violation_field), "нарушения", default=0)
        if present <= 0:
            scores.append(0.0)
            continue
        if violations > present:
            raise ValueError("Нарушений не может быть больше присутствующих")
        scores.append(_clamp_score(10 * (present - violations) / present))

    return {
        "points": round(sum(scores) / len(scores), 2) if scores else 0.0,
        "applicable": True,
        "completed": bool(scores),
        "measurement_count": len(rows),
    }


def normalize_direction(
    criterion_results: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    rows = list(criterion_results)
    applicable = [item for item in rows if item.get("applicable", True)]
    if not applicable:
        return {
            "points": None,
            "applicable_criteria": 0,
            "completed_criteria": 0,
        }

    raw_points = sum(float(item.get("points") or 0) for item in applicable)
    points = raw_points / (len(applicable) * 10) * 100
    return {
        "points": round(points, 2),
        "applicable_criteria": len(applicable),
        "completed_criteria": sum(bool(item.get("completed")) for item in applicable),
    }


def overall_rating(direction_points: Iterable[float | None]) -> float:
    values = [float(value) for value in direction_points if value is not None]
    return round(sum(values) / len(values), 2) if values else 0.0
