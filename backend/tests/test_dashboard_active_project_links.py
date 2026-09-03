import datetime
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.routers import dashboard


def functional_request(record_id, request_id, status, project="CR-676"):
    return SimpleNamespace(
        id=record_id, request_id=request_id, status=status,
        cr_number=project, epic_number=None,
        application_name="TEST APP", department="IT - Software",
        updated_at=datetime.datetime(2026, 9, 3, 12),
    )


class ActiveProjectRequestLinkTests(unittest.TestCase):
    def get_detail(self, requests, page=1, page_size=5, search=None):
        scoped_query = Mock()
        scoped_query.filter.return_value.all.return_value = requests
        with patch.object(dashboard, "dashboard_department_scope", return_value=["IT - Software"]), \
             patch.object(dashboard, "_join_qa_department", return_value=scoped_query):
            return dashboard.dashboard_attention_detail(
                "active-projects", SimpleNamespace(page=page, page_size=page_size, search=search),
                None, None, Mock(), SimpleNamespace(),
            )

    def test_grouped_requests_keep_individual_ids_stages_and_detail_links(self):
        result = self.get_detail([
            functional_request(906, "TQA-FUNC-1906", "READINESS_VERIFICATION"),
            functional_request(907, "TQA-FUNC-1907", "SM_APPROVAL_PENDING"),
        ])
        self.assertEqual(result["total"], 1)
        row = result["rows"][0]
        self.assertEqual(row["request_count"], 2)
        self.assertIsNone(row["route"])
        self.assertEqual(row["linked_requests"], [
            {"id": 906, "request_id": "TQA-FUNC-1906", "status": "READINESS_VERIFICATION", "route": "/functional-requests?openId=906"},
            {"id": 907, "request_id": "TQA-FUNC-1907", "status": "SM_APPROVAL_PENDING", "route": "/functional-requests?openId=907"},
        ])

    def test_single_request_uses_database_id_not_business_id(self):
        row = self.get_detail([functional_request(77, "TQA-FUNC-1906", "TEST_DESIGN")])["rows"][0]
        self.assertEqual(row["route"], "/functional-requests?openId=77")
        self.assertEqual(row["linked_requests"][0]["route"], row["route"])

    def test_pagination_keeps_all_requests_for_a_project_together(self):
        result = self.get_detail([
            functional_request(1, "TQA-FUNC-1", "TEST_DESIGN", "CR-1"),
            functional_request(2, "TQA-FUNC-2", "TEST_DESIGN", "CR-2"),
            functional_request(3, "TQA-FUNC-3", "READINESS_VERIFICATION", "CR-2"),
        ], page=2, page_size=1)
        self.assertEqual(result["total"], 2)
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["project_id"], "CR-2")
        self.assertEqual(len(result["rows"][0]["linked_requests"]), 2)

    def test_search_finds_requests_beyond_first_page_and_keeps_project_total(self):
        requests = [
            functional_request(1, "TQA-FUNC-1", "TEST_DESIGN", "CR-1"),
            functional_request(2, "TQA-FUNC-2", "SM_APPROVAL_PENDING", "CR-2"),
        ]
        for query in ["TQA-FUNC-2", "SM Approval Pending", "SM_APPROVAL_PENDING", "CR-2"]:
            with self.subTest(query=query):
                result = self.get_detail(requests, page_size=1, search=query)
                self.assertEqual(result["total"], 2)
                self.assertEqual(result["total_rows"], 1)
                self.assertEqual(result["rows"][0]["project_id"], "CR-2")

    def test_search_with_no_matches_returns_empty_page(self):
        result = self.get_detail([functional_request(1, "TQA-FUNC-1", "TEST_DESIGN")], search="no-such-project")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["total_rows"], 0)
        self.assertEqual(result["rows"], [])


if __name__ == "__main__":
    unittest.main()
