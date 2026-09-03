import datetime
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from fastapi import HTTPException
from app.routers import dashboard


def request(pk, app, status, url=None):
    return SimpleNamespace(id=pk, request_id=f"REQUEST-{pk}", application_name=app,
        application_url=url, status=status, department="IT", created_at=datetime.datetime(2026, 9, 1),
        updated_at=datetime.datetime(2026, 9, 2))


class SecurityInsightDetailsTests(unittest.TestCase):
    def setUp(self):
        self.reqs = [request(1, "APP A", "REPORT_READY", "https://a.test"),
                     request(2, "APP A", "CLOSED", "https://a.test"),
                     request(3, "APP B", "SM_APPROVAL_PENDING", "https://b.test"),
                     request(4, "APP C", "CLOSED")]
        self.scans = {
            1: SimpleNamespace(total_count=7, critical_count=2, high_count=3, medium_count=1, low_count=1),
            2: SimpleNamespace(total_count=0, critical_count=0, high_count=0, medium_count=0, low_count=0),
        }

    def details(self, kind="SAST", metric="requests", value="", page=1, page_size=5):
        return dashboard._security_insight_detail(kind, metric, value, self.reqs, self.scans,
            SimpleNamespace(page=page, page_size=page_size))

    def test_request_count_and_exact_detail_routes_survive_pagination(self):
        result = self.details(page=2, page_size=2)
        self.assertEqual(result["total"], 4)
        self.assertEqual(result["total_rows"], 4)
        self.assertEqual(len(result["rows"]), 2)
        self.assertTrue(result["has_previous"])
        self.assertFalse(result["has_next"])
        for row in result["rows"]:
            pk = row["request_id"].split("-")[-1]
            self.assertEqual(row["route"], f"/sast?openId={pk}")

    def test_scanned_application_count_is_distinct_but_all_contributing_requests_are_shown(self):
        result = self.details(metric="applications")
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["total_rows"], 3)
        self.assertNotIn("REQUEST-3", [row["request_id"] for row in result["rows"]])

    def test_dast_coverage_excludes_missing_urls_and_unfinished_scans(self):
        result = self.details(kind="DAST", metric="applications")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["total_rows"], 2)
        self.assertTrue(all(row["application_url"] == "https://a.test" for row in result["rows"]))

    def test_findings_total_and_severity_match_the_latest_snapshots(self):
        result = self.details(metric="vulnerabilities")
        self.assertEqual(result["total"], 7)
        self.assertEqual(result["total_rows"], 1)
        self.assertEqual(result["rows"][0]["value"], 7)
        result = self.details(kind="DAST", metric="severity", value="Critical")
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["rows"][0]["value"], 2)
        self.assertEqual(result["rows"][0]["route"], "/dast?openId=1")

    def test_remediation_excludes_requests_that_have_never_been_scanned(self):
        for status, pk in [("Open", 1), ("Resolved", 2)]:
            result = self.details(metric="remediation", value=status)
            self.assertEqual(result["total"], 1)
            self.assertEqual(result["rows"][0]["request_id"], f"REQUEST-{pk}")

    def test_compliance_opens_only_selected_workflow_status(self):
        result = self.details(kind="DAST", metric="compliance", value="CLOSED")
        self.assertEqual(result["total"], 2)
        self.assertTrue(all(row["status"] == "CLOSED" for row in result["rows"]))

    def test_zero_metric_returns_an_empty_detail_instead_of_unrelated_requests(self):
        self.scans = {}
        result = self.details(metric="vulnerabilities")
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["rows"], [])

    def test_detail_endpoint_preserves_date_and_department_scope(self):
        scoped_query = Mock()
        scoped_query.all.return_value = self.reqs[:1]
        with patch.object(dashboard, "dashboard_department_scope", return_value=["IT"]), \
             patch.object(dashboard, "_in_period") as period, \
             patch.object(dashboard, "_join_qa_department", return_value=scoped_query) as scoped, \
             patch.object(dashboard, "_latest_scan_by_request", return_value={1: self.scans[1]}) as scans:
            result = dashboard.security_insight_details("sast", "vulnerabilities", "",
                SimpleNamespace(page=1, page_size=5), "2026-09-01", "2026-09-03", Mock(), Mock())
        self.assertEqual(period.call_args.args[-2:], ("2026-09-01", "2026-09-03"))
        self.assertEqual(scoped.call_args.args[-1], ["IT"])
        self.assertEqual(scans.call_args.args[-1], [1])
        self.assertEqual(result["total"], 7)

    def test_rejects_invalid_severity_and_unknown_metric(self):
        with self.assertRaises(HTTPException):
            self.details(metric="severity", value="unknown")
        with self.assertRaises(HTTPException):
            dashboard.security_insight_details("other", "requests", "", Mock(), None, None, Mock(), Mock())


if __name__ == "__main__":
    unittest.main()
