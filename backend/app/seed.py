"""
Seeds exactly one user per role -- no sample QA requests, test cases, SAST/
DAST requests, or other dummy records. Run with:

    python -m app.seed
"""
from .database import SessionLocal, Base, engine
from . import models
from .auth import hash_password
from .constants import Role, LoginType

Base.metadata.create_all(bind=engine)

DEMO_PASSWORD = "Password@123"

# (username, full_name, role, department) -- one user per role, in the exact
# order of the role list.
DEMO_USERS = [
    ("requester1", "Rahul Deshmukh", Role.REQUESTER, "Digital Banking Department (DBD)"),
    ("ba1", "Ananya Kulkarni", Role.BUSINESS_ANALYST, "Digital Banking Department (DBD)"),
    ("qa1", "Sanjay Patil", Role.QA_ENGINEER, "QA Team"),
    ("qalead1", "Priya Sharma", Role.QA_LEAD, "QA Team"),
    ("exec1", "Vikram Joshi", Role.DEPARTMENT_HEAD_COE, "QA Team"),
    ("security1", "Neha Kale", Role.SECURITY_ANALYST, "Information Security"),
    ("appowner1", "Manoj Bhosale", Role.APPLICATION_OWNER, "Core Banking Systems (CBS)"),
    ("depthead1", "Suresh Rane", Role.DEPARTMENT_HEAD, "Information Technology Department"),
    ("admin", "QA Portal Administrator", Role.ADMIN, "QA Team"),
]


def run():
    db = SessionLocal()
    try:
        if db.query(models.User).count() > 0:
            print("Database already seeded — skipping. Delete qa_portal.db to reseed.")
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
