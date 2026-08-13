"""
Seeds exactly one user per role -- no sample QA requests, test cases, SAST/
DAST requests, or other dummy records. Run with:

    python -m app.seed
"""
from .database import SessionLocal, Base, engine
from . import models
from .auth import hash_password
from .constants import Role, LoginType, SEED_DEPARTMENTS

Base.metadata.create_all(bind=engine)

DEMO_PASSWORD = "Password@123"

# (username, full_name, role, department) -- one user per role, in the exact
# order of the role list.
DEMO_USERS = [
    ("requester1", "Requester 1", Role.REQUESTER, "IT - Software"),
    ("requester2", "Requester 2", Role.REQUESTER, "IT - Software"),
    ("ba1", "BA 1", Role.BUSINESS_ANALYST, "IT - Software"),
    ("qa1", "QA 1", Role.QA_ENGINEER, "COE - Quality Assurance"),
    ("qa2", "QA 2", Role.QA_ENGINEER, "COE - Quality Assurance"),
    # 2026-08: consolidated from 3 seed users (CHEIF_MANAGER_COE/
    # CHEIF_MANAGER_QA/AGM_COE) down to these 2 -- see constants.py::Role's
    # own comment on the role consolidation.
    ("cheifmanagerqa1", "Chief Manager QA", Role.CHIEF_MANAGER_QA, "COE - Quality Assurance"),
    ("agm1", "AGM QA 1", Role.AGM_QA, "COE - Quality Assurance"),
    ("appowner1", "App Owner 1", Role.APPLICATION_OWNER, "IT - Software"),
    ("depthead1", "Department Head CM 1", Role.DEPARTMENT_HEAD_CM, "IT - Software"),
    ("depthead2", "Department Head AGM 1", Role.DEPARTMENT_HEAD_AGM, "IT - Software"),
    # New SM checkpoint role (sits between Requester and Department Head on
    # QA Request / SAST-DAST / Suppression workflows).
    ("sm1", "SM 1", Role.SM, "IT - Software"),
    ("sm2", "SM 2", Role.SM, "IT - Software"),
    ("admin", "Administrator", Role.ADMIN, "COE - Quality Assurance"),
]

LEGACY_DEMO_NAMES = {
    "depthead1": ("Dep Head Of Req 1", "Department Head 1"),
    "depthead2": ("Dep Head Of Req 1", "Department Head 2"),
    "sm1": ("SM 1 Of Req 1", "SM 1"),
    "sm2": ("SM 2 Of Req 1", "SM 2"),
}


def _seed_departments(db):
    if db.query(models.Department).count() > 0:
        return
    for name in SEED_DEPARTMENTS:
        db.add(models.Department(name=name, is_active=True))
    db.commit()
    print(f"Seeded {len(SEED_DEPARTMENTS)} departments.")


def _normalize_legacy_demo_names(db):
    """Removes the old request-specific suffix from seeded display names
    without overwriting any name an administrator has already customized."""
    changed = 0
    for username, (legacy_name, display_name) in LEGACY_DEMO_NAMES.items():
        user = db.query(models.User).filter_by(username=username, full_name=legacy_name).first()
        if user:
            user.full_name = display_name
            changed += 1
    if changed:
        db.commit()
        print(f"Updated {changed} legacy demo display name(s).")


def run():
    db = SessionLocal()
    try:
        # Departments are seeded independently of the users check below so
        # that re-running against a DB that already has users (but predates
        # the Department table) still backfills the department list.
        _seed_departments(db)
        _normalize_legacy_demo_names(db)

        if db.query(models.User).count() > 0:
            print("Users already seeded — skipping new-user creation.")
            return

        for username, full_name, role, dept in DEMO_USERS:
            db.add(models.User(
                username=username, full_name=full_name, department=dept,
                role_assignments=[models.UserRole(role=role)],
                # 2026-08 "one user can be on multiple departments" CR --
                # every demo user still gets exactly one department, seeded
                # through the new department_assignments relationship (not
                # just the legacy `department` column above) so seeded
                # accounts behave identically to ones created through
                # Admin.tsx post-migration, rather than relying on the
                # User.departments property's own legacy-column fallback.
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
    finally:
        db.close()


if __name__ == "__main__":
    run()
