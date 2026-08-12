"""Shared helpers for the app-wide "Reassignment" requirement (2026-08 CR),
reported directly:

    Everywhere the system provides an Assign option -- Assign Tester, Assign
    Defect, Assign QA Lead, Assign Analyst -- it must also provide a
    Reassign option. Reassignment shall be permitted to: the current
    assignee, the Department Head of the department the current assignee
    belongs to, or an Administrator. During reassignment: only eligible
    users for that activity shall be displayed; a reassignment reason shall
    be mandatory; the new assignee shall receive a notification; the
    previous assignee shall lose action permission after reassignment; the
    record's status/history shall remain unchanged; previous assignee, new
    assignee, reassigned by, date/time, and reason shall be captured in the
    audit history.

Scope note (confirmed directly before implementing): this covers the real,
already-populated assignee fields -- Functional/Performance tester(s), SAST/
DAST Security Analyst, Test Execution runner, Test Cycle owner, and Defect
assignee. FunctionalRequest.qa_lead_id / SAST&DASTRequest.security_lead_id /
PerformanceRequest.engineer_id are vestigial (never actually set to a real
person anywhere in this codebase) and TestCaseVersion.assigned_reviewer_id/
assigned_qa_lead_id reassignment was deliberately disabled in the 2026-08
"Simplified Test Management" refactor in favor of role-group routing --
both were explicitly confirmed out of scope rather than silently skipped.

Department Head mapping is the CR's own clarification table:
    COE - Quality Assurance -> Assistant General Manager - QA, Chief Manager - QA
                               (Role.AGM_QA / Role.CHIEF_MANAGER_QA)
    every other department  -> Chief Manager - Department, Assistant General
                               Manager - Department
                               (Role.DEPARTMENT_HEAD_CM / Role.DEPARTMENT_HEAD_AGM)
A "Department Head" is scoped to their OWN department, not just the role
title in isolation -- matches deps.py's existing department-binding for
DEPARTMENT_HEAD_CM/AGM elsewhere in this app (a Chief Manager of one
department must not be able to reassign another department's records).

"The previous assignee shall lose action permission after reassignment" is
satisfied structurally, not by a separate flag: every eligibility check in
this app re-reads the assignee column fresh on each request (no caching),
so overwriting it to the new assignee is sufficient -- there is nothing
further for this module to enforce.
"""
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import models
from .constants import Role, QA_DEPARTMENT
from .routers import notifications


def department_head_roles(department: Optional[str]) -> tuple:
    """Which two Department Head roles apply for `department`, per the CR's
    clarification table."""
    return (Role.CHIEF_MANAGER_QA, Role.AGM_QA) if department == QA_DEPARTMENT \
        else (Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM)


def department_head_user_ids(db: Session, department: Optional[str]) -> List[int]:
    """Every active user who is a Department Head of `department` -- role
    AND department both matching (see module docstring).

    2026-08 "one user can be on multiple departments" CR -- a Department
    Head who now belongs to several departments still qualifies here as long
    as `department` is ONE of theirs, not necessarily their primary one --
    uses the department_assignments join table via has_department(), same as
    every other membership check in this module."""
    if not department:
        return []
    roles = set(department_head_roles(department))
    candidates = db.query(models.User).filter(
        models.User.department_assignments.any(models.UserDepartment.department == department),
        models.User.is_active == True,  # noqa: E712
    ).all()
    return [u.id for u in candidates if set(u.roles) & roles]


def require_can_reassign(current_user: models.User, current_assignee_id: Optional[int],
                          department) -> None:
    """403s unless `current_user` is the current assignee, a Department Head
    of `department`, or an Administrator (has_role's own Admin bypass covers
    the last one). `department` is the CURRENT ASSIGNEE's department -- the
    person being reassigned FROM, not the department the record itself
    lives in, per "the Department Head of the department to which the
    current assignee belongs."

    2026-08 "one user can be on multiple departments" CR -- `department` may
    now be a single string (legacy callers) OR a list (a previous
    assignee's full `.departments`, the normal case now). `current_user`
    qualifies as Department Head if they belong to (has_department) AND
    hold the Department Head role for ANY ONE of the given departments --
    not necessarily the previous assignee's primary one."""
    if current_user.has_role(Role.ADMIN):
        return
    if current_assignee_id and current_user.id == current_assignee_id:
        return
    departments = [department] if isinstance(department, str) else list(department or [])
    for dept in departments:
        if dept and current_user.has_department(dept) \
                and set(current_user.roles) & set(department_head_roles(dept)):
            return
    raise HTTPException(
        403,
        "Only the current assignee, the Department Head of their department, "
        "or an Administrator can reassign this",
    )


def require_reason(reason: Optional[str]) -> str:
    """A reassignment reason is mandatory -- same 400-on-blank convention as
    every other required free-text field in this app (see routers'
    `_required` helpers)."""
    if not reason or not reason.strip():
        raise HTTPException(400, "A reassignment reason is required")
    return reason.strip()


def record_reassignment(db: Session, entity_type: str, entity_id: int, actor: models.User,
                         previous_label: str, new_label: str,
                         reason: str, step_name: str = "Reassignment") -> None:
    """Writes the audit-trail row the CR requires -- previous assignee, new
    assignee, reassigned by (actor_id), date/time (created_at), and reason
    (comments) -- reusing the same ApprovalAction table every other
    workflow decision in this app already writes to (defects.py::_audit,
    functional.py::_log, etc.), not a new parallel mechanism.

    `previous_label`/`new_label` are plain display strings (a name, a
    comma-joined list of names, or "Unassigned") rather than User objects --
    some of the flows this covers (Functional/Performance testers) assign a
    LIST of people, not a single one, so the caller is better placed to
    format that than this shared helper would be."""
    db.add(models.ApprovalAction(
        entity_type=entity_type, entity_id=entity_id, step_name=step_name,
        actor_id=actor.id, actor_role=actor.roles_csv, decision="Reassigned",
        comments=reason, previous_state=previous_label, new_state=new_label,
    ))


def notify_new_assignee(db: Session, new_assignee_id: int, entity_type: str, entity_id: int,
                         entity_key: Optional[str], message: str, actor_id: int) -> None:
    """"The new assignee shall receive a notification" -- delegates to the
    same in-app Notification mechanism every other notified event in this
    app already uses (routers/notifications.py::fire); caller's existing
    db.commit() covers this row too, same transaction."""
    notifications.fire(db, [new_assignee_id], "Reassigned", entity_type, entity_id, entity_key, message, actor_id)
