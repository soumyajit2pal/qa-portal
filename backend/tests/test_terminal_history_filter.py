import datetime
import unittest

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models, pagination


def page_params(**changes):
    values = {
        "page": 1, "page_size": 5, "search": None, "status": None,
        "department": None, "raised_from": None, "raised_to": None,
        "sort_by": None, "sort_order": "desc",
    }
    values.update(changes)
    return pagination.PageParams(**values)


class TerminalHistoryFilterTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        self.db = sessionmaker(bind=self.engine)()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_range_applies_only_to_terminal_statuses(self):
        query = pagination.apply_terminal_raised_date_filter(
            self.db.query(models.FunctionalRequest),
            page_params(raised_from="2026-08-01", raised_to="2026-08-31"),
            models.FunctionalRequest.status,
            models.FunctionalRequest.created_at,
            ["CLOSED", "CANCELLED"],
        )
        sql = str(query.statement.compile(compile_kwargs={"literal_binds": True}))
        # The first two branches retain NULL/active statuses.  Date checks
        # appear only in the terminal-status branch.
        self.assertIn("status IS NULL", sql)
        self.assertIn("status NOT IN ('CLOSED', 'CANCELLED')", sql)
        self.assertIn("status IN ('CLOSED', 'CANCELLED') AND", sql)
        self.assertIn("created_at >= '2026-08-01 00:00:00'", sql)
        self.assertIn("created_at <= '2026-08-31 23:59:59.999999'", sql)

    def test_ist_date_only_bounds_cover_the_whole_day(self):
        self.assertEqual(
            pagination._raised_date_bound("2026-08-29", end=False),
            datetime.datetime(2026, 8, 29, 0, 0),
        )
        self.assertEqual(
            pagination._raised_date_bound("2026-08-29", end=True),
            datetime.datetime(2026, 8, 29, 23, 59, 59, 999999),
        )
        with self.assertRaises(HTTPException):
            pagination.apply_terminal_raised_date_filter(
                self.db.query(models.FunctionalRequest),
                page_params(raised_from="2026-09-01", raised_to="2026-08-31"),
                models.FunctionalRequest.status,
                models.FunctionalRequest.created_at,
                ["CLOSED"],
            )


if __name__ == "__main__":
    unittest.main()
