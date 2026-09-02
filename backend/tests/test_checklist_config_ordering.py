import os
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Router imports initialize the application's Oracle-only engine. The unit
# tests below use their own isolated SQLite session and never connect through
# this URL; it only satisfies that import-time production guard.
os.environ.setdefault(
    "DATABASE_URL",
    "oracle+oracledb://unit:unit@localhost:1521/?service_name=UNIT",
)

from app import models, schemas
from app.routers.checklist_config import create_item, reorder_items


class ChecklistConfigOrderingTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        models.ChecklistTemplateItem.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.rows = [
            models.ChecklistTemplateItem(
                module="FUNCTIONAL",
                item=f"Item {index}",
                sort_order=sort_order,
                active=True,
            )
            for index, sort_order in enumerate((0, 1, 3), start=1)
        ]
        self.db.add_all(self.rows)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    @patch("app.routers.checklist_config._invalidate_active_items_cache")
    def test_new_item_appends_after_highest_existing_order(self, _invalidate):
        created = create_item(
            "FUNCTIONAL",
            schemas.ChecklistTemplateItemCreate(item="New item"),
            self.db,
            current_user=None,
        )

        self.assertEqual(created.sort_order, 4)

    @patch("app.routers.checklist_config._invalidate_active_items_cache")
    def test_reorder_is_persisted_as_one_contiguous_sequence(self, _invalidate):
        ids = [row.id for row in self.rows]

        result = reorder_items(
            "FUNCTIONAL",
            schemas.ChecklistTemplateOrderUpdate(ordered_ids=[ids[2], ids[0], ids[1]]),
            self.db,
            current_user=None,
        )

        self.assertEqual([row.id for row in result], [ids[2], ids[0], ids[1]])
        self.assertEqual([row.sort_order for row in result], [0, 1, 2])


if __name__ == "__main__":
    unittest.main()
