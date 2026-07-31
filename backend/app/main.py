from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine
from . import models  # noqa: F401  (ensures models are registered before create_all)
from .routers import (
    auth, qa_requests, functional,
    sast_dast, suppression, performance,
    approvals, signoff, dashboard, reports, export, departments, applications,
    test_projects, test_repository, test_execution,
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
app.include_router(functional.router)
app.include_router(sast_dast.router)
app.include_router(suppression.router)
app.include_router(performance.router)
app.include_router(approvals.router)
app.include_router(signoff.router)
app.include_router(dashboard.router)
app.include_router(reports.router)
app.include_router(export.router)
app.include_router(departments.router)
app.include_router(applications.router)
app.include_router(test_projects.router)
app.include_router(test_repository.router)
app.include_router(test_execution.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
