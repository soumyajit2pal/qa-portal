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
    ("qa1", "QA 1", Role.QA_ENGINEER, "IT - QA"),
    ("qa2", "QA 2", Role.QA_ENGINEER, "IT - QA"),
    ("qalead1", "QA Lead 1", Role.QA_LEAD, "IT - QA"),
    ("cm1", "Dep head CM 1", Role.DEPARTMENT_HEAD_COE_CM, "IT - QA"),
    ("agm1", "Dep head COE 1", Role.DEPARTMENT_HEAD_COE_AGM, "IT - QA"),
    ("security1", "SA 1", Role.SECURITY_ANALYST, "IT - QA"),
    ("appowner1", "App Owner 1", Role.APPLICATION_OWNER, "IT - Software"),
    ("depthead1", "Dep Head Of Req 1", Role.DEPARTMENT_HEAD_CM, "IT - Software"),
    ("depthead2", "Dep Head Of Req 1", Role.DEPARTMENT_HEAD_AGM, "IT - Software"),
    # New SM checkpoint role (sits between Requester and Department Head on
    # QA Request / SAST-DAST / Suppression workflows).
    ("sm1", "SM 1 Of Req 1", Role.SM, "IT - Software"),
    ("sm2", "SM 2 Of Req 1", Role.SM, "IT - Software"),
    ("admin", "Administrator", Role.ADMIN, "IT - QA"),
]


def _seed_departments(db):
    if db.query(models.Department).count() > 0:
        return
    for name in SEED_DEPARTMENTS:
        db.add(models.Department(name=name, is_active=True))
    db.commit()
    print(f"Seeded {len(SEED_DEPARTMENTS)} departments.")


def run():
    db = SessionLocal()
    try:
        # Departments are seeded independently of the users check below so
        # that re-running against a DB that already has users (but predates
        # the Department table) still backfills the department list.
        _seed_departments(db)

        if db.query(models.User).count() > 0:
            print("Users already seeded — skipping. Delete qa_portal.db to reseed.")
            return

        for username, full_name, role, dept in DEMO_USERS:
            db.add(models.User(
                username=username, full_name=full_name, department=dept,
                role_assignments=[models.UserRole(role=role)],
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
