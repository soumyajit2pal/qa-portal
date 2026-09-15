"""
Seeds baseline users for the operational workflow roles -- no sample QA
requests, test cases, SAST/DAST requests, or other dummy records. Run with:

    python -m app.seed
"""
import os

from .database import SessionLocal
from . import models
from .auth import hash_password
from .constants import Role, LoginType, SEED_DEPARTMENTS

DEMO_PASSWORD = os.getenv("DEMO_SEED_PASSWORD", "")

# (username, full_name, role, department) -- ordered by workflow responsibility.
DEMO_USERS = [
    ("requester1", "Requester 1", Role.REQUESTER, "IT - Software"),
    ("requester2", "Requester 2", Role.REQUESTER, "IT - Software"),
    ("developer1", "Developer 1", Role.DEVELOPER, "IT - Software"),
    ("ba1", "BA 1", Role.BUSINESS_ANALYST, "IT - Software"),
    ("qa1", "QA 1", Role.QA_ENGINEER, "COE - Quality Assurance"),
    ("qa2", "QA 2", Role.QA_ENGINEER, "COE - Quality Assurance"),
    ("chiefmanagerqa1", "Chief Manager QA", Role.CHIEF_MANAGER_QA, "COE - Quality Assurance"),
    ("agm1", "AGM QA 1", Role.AGM_QA, "COE - Quality Assurance"),
    ("appowner1", "App Owner 1", Role.APPLICATION_OWNER, "IT - Software"),
    ("depthead1", "Department Head CM 1", Role.DEPARTMENT_HEAD_CM, "IT - Software"),
    ("depthead2", "Department Head AGM 1", Role.DEPARTMENT_HEAD_AGM, "IT - Software"),
    ("sm1", "SM 1", Role.SM, "IT - Software"),
    ("sm2", "SM 2", Role.SM, "IT - Software"),
    ("admin", "Administrator", Role.ADMIN, "Other"),
]

def _seed_departments(db):
    existing_names = {
        row.name.strip().casefold()
        for row in db.query(models.Department).all()
        if row.name and row.name.strip()
    }
    added = 0
    for name in SEED_DEPARTMENTS:
        if name.strip().casefold() not in existing_names:
            db.add(models.Department(name=name, is_active=True))
            existing_names.add(name.strip().casefold())
            added += 1
    db.commit()
    print(f"Department seed complete: {added} added, {len(SEED_DEPARTMENTS) - added} already present.")


def _seed_default_workspace(db):
    workspace = db.query(models.QAWorkspace).filter(
        models.QAWorkspace.workspace_key == "DEFAULT",
    ).first()
    if not workspace:
        workspace = models.QAWorkspace(
            workspace_key="DEFAULT", name="Default Workspace",
            description="Default workspace for first-time users", is_active=True, is_default=True,
        )
        db.add(workspace); db.flush()
    else:
        workspace.name = "Default Workspace"
        workspace.description = "Default workspace for first-time users"
        workspace.is_active = True
    db.query(models.QAWorkspace).filter(models.QAWorkspace.id != workspace.id).update(
        {models.QAWorkspace.is_default: False}, synchronize_session=False,
    )
    workspace.is_default = True

    # Only System Administrators are seeded as required members. Other users
    # receive this workspace when they first authenticate, through
    # ensure_default_workspace_membership().
    from .workspace_service import ensure_administrator_workspace_memberships
    ensure_administrator_workspace_memberships(db, workspace=workspace)
    db.commit()


def run():
    if len(DEMO_PASSWORD) < 12 or len(DEMO_PASSWORD.encode("utf-8")) > 72:
        raise RuntimeError(
            "Set DEMO_SEED_PASSWORD to a unique value of at least 12 characters "
            "and no more than 72 UTF-8 bytes before running the demo seed."
        )
    db = SessionLocal()
    try:
        # Departments are seeded independently of the users check below so
        # that re-running against a DB that already has users (but predates
        # the Department table) still backfills the department list.
        _seed_departments(db)
 
        if db.query(models.User).count() > 0:
            print("Users already seeded — skipping new-user creation.")
        else:
            for username, full_name, role, dept in DEMO_USERS:
                db.add(models.User(
                    username=username, full_name=full_name, department=dept,
                    role_assignments=[models.UserRole(role=role)],
                    department_assignments=[models.UserDepartment(department=dept)] if dept else [],
                    email=f"{username}@bankofmaharashtra.bank.in",
                    login_type=LoginType.STANDARD,
                    hashed_password=hash_password(DEMO_PASSWORD),
                ))
            db.commit()
            print("Seed complete.")
            print(f"Demo users (password for all: {DEMO_PASSWORD}):")
            for username, full_name, role, dept in DEMO_USERS:
                print(f"  {username:14s} | {role:20s} | {full_name}")
        _seed_default_workspace(db)
    finally:
        db.close()


if __name__ == "__main__":
    run()
