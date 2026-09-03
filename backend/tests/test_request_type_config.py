import os
import unittest

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

os.environ.setdefault(
    "DATABASE_URL",
    "oracle+oracledb://unit:unit@localhost:1521/?service_name=UNIT",
)

from app import models
from app.constants import REQUEST_TYPES
from app.request_type_config import get_request_type_configs, inactive_request_types
from app.routers.qa_requests import _validate_request_types


class RequestTypeConfigTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        models.RequestTypeConfig.__table__.create(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_bootstraps_every_supported_request_type_as_active(self):
        rows = get_request_type_configs(self.db)

        self.assertEqual([row.request_type for row in rows], REQUEST_TYPES)
        self.assertTrue(all(row.is_active for row in rows))

    def test_deactivated_type_is_reported_and_rejected(self):
        rows = get_request_type_configs(self.db)
        rows[1].is_active = False
        self.db.flush()

        self.assertEqual(inactive_request_types(self.db, [REQUEST_TYPES[1]]), [REQUEST_TYPES[1]])
        with self.assertRaises(HTTPException) as raised:
            _validate_request_types(self.db, [REQUEST_TYPES[1]])
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Disabled Request Type", raised.exception.detail)

    def test_active_type_remains_valid(self):
        get_request_type_configs(self.db)

        _validate_request_types(self.db, [REQUEST_TYPES[0]])


if __name__ == "__main__":
    unittest.main()
