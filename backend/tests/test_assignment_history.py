import datetime
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models, reassignment


class AssignmentHistoryTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(
            engine,
            tables=[models.User.__table__, models.AssignmentHistory.__table__],
        )
        self.db = sessionmaker(bind=engine)()
        self.actor = models.User(id=1, username="manager", full_name="Manager", login_type="STANDARD")
        self.first = models.User(id=2, username="first", full_name="First User", login_type="STANDARD")
        self.second = models.User(id=3, username="second", full_name="Second User", login_type="STANDARD")
        self.db.add_all([self.actor, self.first, self.second])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_initial_assignment_and_reassignment_create_exact_tenures(self):
        reassignment.record_assignment_change(
            self.db, "DEFECT", 41, "DEFECT_ASSIGNEE", self.actor,
            [], [self.first.id], "Initial triage",
        )
        self.db.commit()
        first_tenure = self.db.query(models.AssignmentHistory).one()
        self.assertIsNone(first_tenure.unassigned_at)
        self.assertEqual(first_tenure.assignment_reason, "Initial triage")

        reassignment.record_assignment_change(
            self.db, "DEFECT", 41, "DEFECT_ASSIGNEE", self.actor,
            [self.first.id], [self.second.id], "Workload handoff",
            previous_assigned_at=first_tenure.assigned_at,
        )
        self.db.commit()
        rows = self.db.query(models.AssignmentHistory).order_by(models.AssignmentHistory.id).all()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].assignee_id, self.first.id)
        self.assertIsNotNone(rows[0].unassigned_at)
        self.assertEqual(rows[0].unassignment_reason, "Workload handoff")
        self.assertEqual(rows[1].assignee_id, self.second.id)
        self.assertIsNone(rows[1].unassigned_at)
        self.assertEqual(rows[1].assigned_by_id, self.actor.id)

    def test_legacy_assignment_is_adopted_before_close(self):
        original_start = datetime.datetime(2026, 8, 1, 9, 30)
        reassignment.record_assignment_change(
            self.db, "TEST_EXECUTION", 7, "EXECUTION_RUNNER", self.actor,
            [self.first.id], [self.second.id], "Runner changed",
            previous_assigned_at=original_start,
        )
        self.db.commit()
        rows = self.db.query(models.AssignmentHistory).order_by(models.AssignmentHistory.id).all()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].assigned_at, original_start)
        self.assertIsNone(rows[0].assigned_by_id)
        self.assertIsNotNone(rows[0].unassigned_at)
        self.assertEqual(rows[1].assignee_id, self.second.id)
        self.assertIsNone(rows[1].unassigned_at)


if __name__ == "__main__":
    unittest.main()
