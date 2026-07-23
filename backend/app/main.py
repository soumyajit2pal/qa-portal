from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine
from . import models  # noqa: F401  (ensures models are registered before create_all)
# NOTE: Test Case Repository (Module 2) and Test Execution Management (Module 3)
# are temporarily DISABLED per request -- routers are still fully implemented in
# routers/test_cases.py and routers/test_runs.py, just not imported/mounted below.
# To re-enable: uncomment the import below, the two app.include_router(...) calls
# further down, and the corresponding nav items/routes in
# frontend/src/components/Layout.jsx and frontend/src/App.jsx.
from .routers import (
    auth, qa_requests,  # test_cases, test_runs,
    sast_dast, suppression,
    approvals, signoff, dashboard, reports, export,
)

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Centralized QA Portal API",
    description="Backend for the Bank of Maharashtra Centralized QA Portal "
                 "(Change Request: Centralized QA Portal Creation, FY 2026-27).",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(qa_requests.router)
# app.include_router(test_cases.router)  # DISABLED for now -- see import comment above.
# app.include_router(test_runs.router)   # DISABLED for now -- see import comment above.
app.include_router(sast_dast.router)
app.include_router(suppression.router)
app.include_router(approvals.router)
app.include_router(signoff.router)
app.include_router(dashboard.router)
app.include_router(reports.router)
app.include_router(export.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
