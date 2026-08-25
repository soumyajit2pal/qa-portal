import datetime
import unittest
from types import SimpleNamespace

from app.routers.pending_approvals import _paginate_pending_items


def pending_item(category: str, entity_id: int, submitted_at):
    return {
        "category": category,
        "entity_type": "TEST_CASE",
        "entity_id": entity_id,
        "submitted_at": submitted_at,
    }


class PendingApprovalsPaginationTests(unittest.TestCase):
    def test_pages_are_oldest_first_with_complete_category_counts(self):
        items = [
            pending_item("Review", 3, datetime.datetime(2026, 8, 3)),
            pending_item("Decision", 2, datetime.datetime(2026, 8, 2, tzinfo=datetime.timezone.utc)),
            pending_item("Review", 1, datetime.datetime(2026, 8, 1)),
        ]
        page = _paginate_pending_items(items, SimpleNamespace(page=1, page_size=2), None)
        self.assertEqual([item["entity_id"] for item in page["items"]], [1, 2])
        self.assertEqual(page["category_counts"], {"Review": 2, "Decision": 1})
        self.assertEqual(page["total"], 3)
        self.assertEqual(page["total_pages"], 2)
        self.assertTrue(page["has_next"])

    def test_category_filter_is_applied_before_pagination(self):
        items = [
            pending_item("Review", 1, None),
            pending_item("Decision", 2, datetime.datetime(2026, 8, 2)),
            pending_item("Review", 3, datetime.datetime(2026, 8, 3)),
        ]
        page = _paginate_pending_items(items, SimpleNamespace(page=2, page_size=1), " Review ")
        self.assertEqual([item["entity_id"] for item in page["items"]], [3])
        self.assertEqual(page["total"], 2)
        self.assertTrue(page["has_previous"])
        self.assertFalse(page["has_next"])
        self.assertEqual(page["category_counts"], {"Review": 2, "Decision": 1})


if __name__ == "__main__":
    unittest.main()
