#!/usr/bin/env python3
"""Create reversible, local-only data for portal performance checks.

This script creates QA gateway requests and evenly distributes their linked
children across Functional, SAST, DAST and Performance modules.  It uses the
application's own TQA business-ID counter format and creates no approval
actions, so no SMTP outbox record can result.

Examples (run from ``backend``):

    PYTHONPATH=. python3 scripts/seed_load_test_data.py --count 600
    PYTHONPATH=. python3 scripts/seed_load_test_data.py --append --count 7000
    PYTHONPATH=. python3 scripts/seed_load_test_data.py --clean

The script refuses a non-local DATABASE_URL and every row carries exclusive
request/application prefixes, so ``--clean`` can remove only data it created.
"""

from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta

from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from app import models
from app.constants import GatewayStatus, Role
from app.database import DATABASE_URL, SessionLocal


DEFAULT_COUNT = 600
DEFAULT_DEPARTMENT = "IT - Software"
APPLICATION_PREFIX = "[LOAD TEST] QA Portal application"
ROW_MARKER = "[QA PORTAL LOAD TEST DATA — SAFE TO DELETE]"
LOCAL_DATABASE_HOSTS = {"127.0.0.1", "localhost", "::1"}
COUNTER_SCOPE = date(1900, 1, 1)
INSERT_BATCH_SIZE = 250


def _require_local_database() -> None:
    """Block accidental execution against UAT/production before opening a session."""
    host = (make_url(DATABASE_URL).host or "").lower()
    if host not in LOCAL_DATABASE_HOSTS:
        raise RuntimeError(
            "Refusing to seed a non-local database. "
            f"DATABASE_URL host is {host or '<missing>'!r}; expected one of "
            f"{sorted(LOCAL_DATABASE_HOSTS)}."
        )


def _load_test_filter():
    """Use script-exclusive non-CLOB columns so this remains Oracle-safe.

    ``remarks`` is a CLOB in Oracle and CLOB equality cannot be used in a
    WHERE clause (ORA-22848).  The application-name prefix is dedicated to
    this script; all generated children are removed through their tagged
    parent gateway rows.
    """
    return (models.QARequest.application_name.like(f"{APPLICATION_PREFIX}%"),)


def _requester_for(db, department: str) -> models.User:
    """Choose a real active requester so normal access checks can see the data."""
    requester = (
        db.query(models.User)
        # Oracle stores this legacy Boolean as a numeric flag; ``== True``
        # compiles to ``= 1`` whereas ``is_(True)`` compiles to invalid
        # ``IS 1`` on Oracle.
        .filter(models.User.is_active == True, models.User.department == department)  # noqa: E712
        .order_by(models.User.id)
        .first()
    )
    if requester is None:
        requester = (
            db.query(models.User)
            .filter(models.User.is_active == True)  # noqa: E712
            .order_by(models.User.id)
            .first()
        )
    if requester is None:
        raise RuntimeError("No active user exists. Seed users before creating load-test requests.")
    return requester


def _qa_tester_ids(db, fallback_user_id: int) -> list[int]:
    """Return real QA Engineer accounts for realistic assignment coverage."""
    tester_ids = [
        user_id for (user_id,) in (
            db.query(models.User.id)
            .join(models.UserRole, models.UserRole.user_id == models.User.id)
            .filter(
                models.User.is_active == True,  # noqa: E712 - Oracle Boolean is numeric
                models.UserRole.role == Role.QA_ENGINEER,
            )
            .order_by(models.User.id)
            .all()
        )
    ]
    return tester_ids or [fallback_user_id]


def _reserve_business_ids(db, prefix: str, count: int) -> list[str]:
    """Reserve a consecutive TQA ID range with the same counter as the app.

    Calling ``models.gen_id`` once per row would make 14,000 database round
    trips for a 7,000-request load fixture.  This is the same atomic Oracle
    counter operation, performed once per ID family, then expanded locally.
    The counter remains monotonic and safe alongside normal portal traffic.
    """
    db.execute(
        text(
            "MERGE INTO qap_id_counters target "
            "USING (SELECT :prefix AS prefix, :counter_date AS counter_date FROM dual) source "
            "ON (target.prefix = source.prefix AND target.counter_date = source.counter_date) "
            "WHEN MATCHED THEN UPDATE SET target.next_value = target.next_value + :count "
            "WHEN NOT MATCHED THEN INSERT (prefix, counter_date, next_value) "
            "VALUES (:prefix, :counter_date, :count)"
        ),
        {"prefix": prefix, "counter_date": COUNTER_SCOPE, "count": count},
    )
    end = db.execute(
        text(
            "SELECT next_value FROM qap_id_counters "
            "WHERE prefix = :prefix AND counter_date = :counter_date"
        ),
        {"prefix": prefix, "counter_date": COUNTER_SCOPE},
    ).scalar_one()
    start = int(end) - count + 1
    return [f"{prefix}-{number:02d}" for number in range(start, int(end) + 1)]


def _assigned_tester_ids(index: int, tester_ids: list[int]) -> str:
    """Rotate one- and two-person assignments across the available QA team."""
    primary = tester_ids[index % len(tester_ids)]
    if len(tester_ids) > 1 and index % 3 == 0:
        secondary = tester_ids[(index + 1) % len(tester_ids)]
        return f"{primary},{secondary}"
    return str(primary)


def _delete_existing(db) -> int:
    parent_ids = select(models.QARequest.id).where(*_load_test_filter())
    if db.execute(select(models.QARequest.id).where(*_load_test_filter()).limit(1)).first() is None:
        return 0

    # Delete through the ORM rather than issuing bulk DELETE statements:
    # checklist/evidence relationships are configured as ORM cascades, not
    # database ON DELETE CASCADE constraints.  This is also safe if a future
    # fixture adds one of those dependent rows.
    for child_model in (
        models.FunctionalRequest,
        models.SASTRequest,
        models.DASTRequest,
        models.PerformanceRequest,
    ):
        for child in db.query(child_model).filter(child_model.qa_request_id.in_(parent_ids)).all():
            db.delete(child)
    db.flush()
    parents = db.query(models.QARequest).filter(*_load_test_filter()).all()
    for parent in parents:
        db.delete(parent)
    db.flush()
    count = len(parents)
    db.commit()
    return count


def clean() -> int:
    _require_local_database()
    db = SessionLocal()
    try:
        deleted = _delete_existing(db)
        print(f"Removed {deleted} tagged load-test QA request(s).")
        return deleted
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def seed(count: int, department: str, append: bool = False) -> int:
    _require_local_database()
    if count < 501:
        raise ValueError("--count must be at least 501 so this remains a meaningful load check.")

    db = SessionLocal()
    try:
        existing = db.query(models.QARequest).filter(*_load_test_filter()).count()
        if existing and not append:
            raise RuntimeError(
                f"{existing} tagged load-test row(s) already exist. "
                "Run with --append to add more, or --clean to replace them; no data was changed."
            )

        requester = _requester_for(db, department)
        tester_ids = _qa_tester_ids(db, requester.id)
        target_department = requester.primary_department or requester.department or department
        # Oracle stores plain DateTime columns without timezone metadata.  Keep
        # the generated values in the application-standard IST wall-clock time.
        newest = models.now().replace(tzinfo=None)
        module_specs = (
            ("FUNCTIONAL", "Functional Testing", models.FunctionalRequest,
             models.BUSINESS_ID_PREFIXES["FUNCTIONAL"],
             ("PLANNING", "TESTER_ASSIGNED", "TEST_DESIGN", "EXECUTION_IN_PROGRESS", "QA_COMPLETED", "CLOSED")),
            ("SAST", "SAST", models.SASTRequest,
             models.BUSINESS_ID_PREFIXES["SAST"],
             ("PLANNING", "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION", "REPORT_READY", "CLOSED")),
            ("DAST", "DAST", models.DASTRequest,
             models.BUSINESS_ID_PREFIXES["DAST"],
             ("PLANNING", "CONFIGURATION", "SCANNING", "FINDING_VALIDATION", "REMEDIATION", "REPORT_READY", "CLOSED")),
            ("PERFORMANCE", "Performance Testing", models.PerformanceRequest,
             models.BUSINESS_ID_PREFIXES["PERFORMANCE"],
             ("PLANNING", "ENVIRONMENT_SETUP", "SCRIPT_DEVELOPMENT", "BASELINE", "LOAD_TEST_EXECUTION", "RESULT_ANALYSIS", "REPORT", "CLOSED")),
        )
        qa_ids = _reserve_business_ids(db, models.BUSINESS_ID_PREFIXES["QA_REQUEST"], count)
        module_id_sets = {
            module_name: _reserve_business_ids(db, child_prefix, (count + len(module_specs) - 1 - position) // len(module_specs))
            for position, (module_name, _request_type, _child_model, child_prefix, _statuses) in enumerate(module_specs)
        }
        module_id_positions = {module_name: 0 for module_name, *_rest in module_specs}
        module_counts = {module_name: 0 for module_name, *_rest in module_specs}
        # Oracle returns every generated identity after an ORM flush.  Keeping
        # each flush bounded prevents an oversized RETURNING buffer (the cause
        # of DPY-4011 with a single 7,000-row flush) without compromising the
        # one-transaction, all-or-nothing nature of this fixture.
        for batch_start in range(0, count, INSERT_BATCH_SIZE):
            parent_rows = []
            batch_end = min(batch_start + INSERT_BATCH_SIZE, count)
            for offset in range(batch_start, batch_end):
                index = existing + offset + 1
                created_at = newest - timedelta(days=(index * 37) % 1825, minutes=index % 60)
                module_name, request_type, child_model, _child_prefix, statuses = module_specs[offset % len(module_specs)]
                application_name = f"{APPLICATION_PREFIX} {(index - 1) % 120 + 1:03d}"
                parent = models.QARequest(
                    request_id=qa_ids[offset],
                    request_date=created_at.date(),
                    department=target_department,
                    application_name=application_name,
                    application_owner="Load Test Owner",
                    cr_number=f"LOAD-CR-{index:04d}",
                    change_type="Enhancement",
                    technology_stack="Load-test fixture",
                    environment="SIT",
                    target_promotion_environment="UAT",
                    request_types=request_type,
                    change_description="Synthetic request used only to verify portal query and paging behaviour.",
                    remarks=ROW_MARKER,
                    status=GatewayStatus.RAISED,
                    requester_id=requester.id,
                    created_at=created_at,
                    updated_at=created_at,
                )
                child_id_position = module_id_positions[module_name]
                # Use the module-local position, not the global request index:
                # otherwise a four-way module rotation can accidentally visit
                # only a subset of a six/eight-state workflow.
                child_status = statuses[
                    (child_id_position + existing // len(module_specs)) % len(statuses)
                ]
                child_id = module_id_sets[module_name][child_id_position]
                module_id_positions[module_name] += 1
                parent_rows.append((parent, module_name, child_model, child_id, child_status, created_at, application_name, index))

            # Assign Oracle primary keys for just this bounded batch, then add
            # its children.  Bulk INSERT avoids workflow/event listeners.
            db.add_all([row[0] for row in parent_rows])
            db.flush()
            child_rows = {module_name: [] for module_name, *_rest in module_specs}
            for parent, module_name, _child_model, child_id, child_status, created_at, application_name, index in parent_rows:
                base = {
                    "request_id": child_id,
                    "status": child_status,
                    "requester_id": requester.id,
                    "qa_request_id": parent.id,
                    "created_at": created_at,
                    "updated_at": created_at,
                }
                if module_name == "FUNCTIONAL":
                    base.update({
                        "priority": "Medium", "risk_rating": "Medium",
                        "assigned_tester_ids": _assigned_tester_ids(index, tester_ids),
                    })
                elif module_name == "SAST":
                    base.update({
                        "application_name": application_name,
                        "cr_number": f"LOAD-CR-{index:04d}",
                        "priority": "Medium", "risk_category": "Medium",
                    })
                elif module_name == "DAST":
                    base.update({"priority": "Medium", "risk_category": "Medium"})
                else:
                    base.update({
                        "application_name": application_name,
                        "cr_number": f"LOAD-CR-{index:04d}",
                        "tool_used": "JMeter", "target_load": "Synthetic load test",
                        "environment": "SIT", "priority": "Medium", "risk_category": "Medium",
                        "request_type": "Load Testing", "change_type": "Enhancement",
                        "technology_stack": "Load-test fixture", "target_promotion_environment": "UAT",
                        "engineer_id": tester_ids[index % len(tester_ids)],
                        "assigned_tester_ids": _assigned_tester_ids(index, tester_ids),
                    })
                child_rows[module_name].append(base)
                module_counts[module_name] += 1
            for module_name, _request_type, child_model, _child_prefix, _statuses in module_specs:
                if child_rows[module_name]:
                    db.bulk_insert_mappings(child_model, child_rows[module_name])
        db.commit()
        breakdown = ", ".join(f"{name.title()}: {module_count}" for name, module_count in module_counts.items())
        print(
            f"Created {count} raised QA requests plus {count} linked module requests "
            f"for requester {requester.username!r} in {target_department!r} ({breakdown}); "
            f"tester pool size={len(tester_ids)}. "
            "No workflow actions or email notifications were created."
        )
        return count
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT, help=f"Number of rows to add (default: {DEFAULT_COUNT}).")
    parser.add_argument("--department", default=DEFAULT_DEPARTMENT, help=f"Preferred requester department (default: {DEFAULT_DEPARTMENT!r}).")
    parser.add_argument("--clean", action="store_true", help="Delete only rows created by this script.")
    parser.add_argument("--append", action="store_true", help="Add to the existing tagged load-test fixture instead of refusing it.")
    args = parser.parse_args()

    if args.clean:
        clean()
    else:
        seed(args.count, args.department, append=args.append)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Load-test seed failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
