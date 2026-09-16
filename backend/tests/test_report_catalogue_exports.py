"""Regression checks for full-population catalogue downloads."""

import asyncio
import io

import pytest
from fastapi import HTTPException
from openpyxl import load_workbook

from app.routers import test_reports


def _defect_row(key):
    return {
        "defect_key": key, "title": f"Title {key}", "qa_request_key": "TQA-REQ-1",
        "application_name": "App", "module_feature": "Module", "severity": "High", "status": "Open",
        "cycle_keys": ["TQA-CYCLE-1"], "test_case_keys": ["TQA-TC-1"],
        "resolved_by_name": None, "reopen_count": 0, "target_release": None, "updated_at": None,
    }


def _download_workbook(response):
    async def collect():
        return b"".join([part async for part in response.body_iterator])
    return load_workbook(io.BytesIO(asyncio.run(collect())), read_only=True)


def test_defect_export_uses_full_filtered_register_not_screen_page(monkeypatch):
    calls = []

    def report(project_id, resolver_id, reopened_only, limit, offset, db, current_user):
        calls.append((project_id, resolver_id, reopened_only, limit, offset))
        return {
            "project_key": "TQA-PROJ-1", "population_note": "Visible project defects",
            "total_governed_defects": 12, "total_items": 12, "open_defects": 12,
            "resolved_defects": 0, "reopened_defects": 0, "retest_success_rate_pct": 0,
            "items": [_defect_row(f"TQA-DEF-{i}") for i in range(12)],
            "resolution_activity": [], "by_module": [], "by_status": [],
        }

    monkeypatch.setattr(test_reports, "defect_quality", report)
    response = test_reports.export_catalogue_report(
        "defects", project_id=4, cycle_id=None, search=None, requirement_type="all",
        resolver_id=9, reopened_only=True, db=object(), current_user=object(),
    )
    workbook = _download_workbook(response)
    assert calls == [(4, 9, True, 10 ** 9, 0)]
    assert workbook["Defect Register"].max_row >= 16  # title + subtitle + headers + 12 records
    assert "TQA-DEF-11" in [cell.value for row in workbook["Defect Register"] for cell in row]


def test_export_requires_the_report_scope():
    with pytest.raises(HTTPException, match="Select a Test Project"):
        test_reports.export_catalogue_report(
            "health", project_id=None, cycle_id=None, search=None, requirement_type="all",
            resolver_id=None, reopened_only=False, db=object(), current_user=object(),
        )
