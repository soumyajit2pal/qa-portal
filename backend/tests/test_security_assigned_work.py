import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.routers.sast_dast import _sast_dast_named_assignment


class SecurityAssignedWorkTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(self.engine, tables=[
            models.User.__table__, models.QARequest.__table__,
            models.SASTRequest.__table__, models.DASTRequest.__table__,
        ])
        self.db = sessionmaker(bind=self.engine)()
        self.db.add_all([
            models.User(id=1, username="requester", full_name="Requester", login_type="STANDARD"),
            models.User(id=2, username="analyst", full_name="Analyst", login_type="STANDARD"),
            models.SASTRequest(
                id=11, request_id="TQA-SAST-11", application_name="Portal",
                requester_id=1, security_analyst_id=2, status="WAITING_FOR_FIX",
            ),
            models.SASTRequest(
                id=12, request_id="TQA-SAST-12", application_name="Portal",
                requester_id=1, security_analyst_id=2, status="SCANNING",
            ),
            models.DASTRequest(
                id=21, request_id="TQA-DAST-21",
                requester_id=1, security_analyst_id=2, status="WAITING_FOR_FIX",
            ),
            models.DASTRequest(
                id=22, request_id="TQA-DAST-22",
                requester_id=1, security_analyst_id=2, status="SCANNING",
            ),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def assigned_ids(self, model, user_id):
        # Delegation is tested by its own query path; this test isolates the
        # normal named-owner predicate that caused the requester regression.
        query = self.db.query(model).filter(
            _sast_dast_named_assignment(model, user_id),
        )
        return {row.id for row in query.all()}

    def test_waiting_for_fix_is_assigned_to_requester(self):
        self.assertEqual(self.assigned_ids(models.SASTRequest, 1), {11})
        self.assertEqual(self.assigned_ids(models.DASTRequest, 1), {21})

    def test_waiting_for_fix_is_removed_from_analyst_queue(self):
        self.assertEqual(self.assigned_ids(models.SASTRequest, 2), {12})
        self.assertEqual(self.assigned_ids(models.DASTRequest, 2), {22})


if __name__ == "__main__":
    unittest.main()
