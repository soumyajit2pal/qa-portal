from types import SimpleNamespace
import unittest
import datetime

from fastapi import HTTPException
from pydantic import ValidationError

from app.execution_cycles import execution_cycle_choice, require_cycle_startable, require_cycle_unlinkable, require_cycles_completed
from app.routers import functional
from app.schemas import TestCycleCreate as CycleCreateSchema, TestCycleUpdate as CycleUpdateSchema


class FunctionalExecutionCycleRequirementTests(unittest.TestCase):
    def test_functional_unlink_endpoint_uses_the_shared_cycle_guard(self):
        self.assertIs(functional.require_cycle_unlinkable, require_cycle_unlinkable)

    def test_cycle_creation_allows_a_standalone_cycle(self):
        cycle = CycleCreateSchema(
            name="Regression",
            start_date=datetime.date(2026, 9, 5),
            end_date=datetime.date(2026, 9, 6),
            environment="UAT",
            build="2026.09.05",
        )
        self.assertIsNone(cycle.linked_request_id)
        self.assertIsNone(cycle.linked_request_type)

    def test_cycle_creation_requires_a_complete_optional_link_pair(self):
        with self.assertRaises(ValidationError):
            CycleCreateSchema(
                name="Regression",
                start_date=datetime.date(2026, 9, 5),
                end_date=datetime.date(2026, 9, 6),
                environment="UAT",
                build="2026.09.05",
                linked_request_id=12,
            )

    def test_cycle_creation_rejects_non_functional_request_types(self):
        with self.assertRaises(ValidationError):
            CycleCreateSchema(
                name="Security",
                start_date=datetime.date(2026, 9, 5),
                end_date=datetime.date(2026, 9, 6),
                environment="UAT",
                build="2026.09.05",
                linked_request_type="SAST",
                linked_request_id=12,
            )

    def test_cycle_creation_accepts_a_functional_request(self):
        cycle = CycleCreateSchema(
            name="Regression",
            start_date=datetime.date(2026, 9, 5),
            end_date=datetime.date(2026, 9, 6),
            environment="UAT",
            build="2026.09.05",
            linked_request_type="Functional",
            linked_request_id=12,
        )

        self.assertEqual(cycle.linked_request_type, "Functional")
        self.assertEqual(cycle.linked_request_id, 12)

    def test_cycle_update_rejects_non_functional_request_types(self):
        with self.assertRaises(ValidationError):
            CycleUpdateSchema(linked_request_type="DAST", linked_request_id=12)

    def test_start_execution_requires_cycle_when_request_has_no_link(self):
        with self.assertRaises(HTTPException) as raised:
            execution_cycle_choice(None, None)

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("must be linked", raised.exception.detail)

    def test_start_execution_reuses_existing_cycle_without_new_selection(self):
        cycle = SimpleNamespace(id=17, cycle_key="TC-17")
        existing_link = SimpleNamespace(cycle_id=17, cycle=cycle)

        resolved_cycle, should_create_link = execution_cycle_choice(existing_link, None)

        self.assertIs(resolved_cycle, cycle)
        self.assertFalse(should_create_link)

    def test_start_execution_rejects_replacing_existing_cycle(self):
        cycle = SimpleNamespace(id=17, cycle_key="TC-17")
        existing_link = SimpleNamespace(cycle_id=17, cycle=cycle)

        with self.assertRaises(HTTPException) as raised:
            execution_cycle_choice(existing_link, 18)

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("already linked", raised.exception.detail)

    def test_start_execution_rejects_an_already_completed_link(self):
        with self.assertRaises(HTTPException) as raised:
            require_cycle_startable(SimpleNamespace(status="Completed"))

        self.assertIn("linked Test Cycle is Completed", raised.exception.detail)

    def test_start_execution_accepts_an_in_progress_link(self):
        require_cycle_startable(SimpleNamespace(status="In Progress"))

    def test_cycle_cannot_be_unlinked_after_execution_starts(self):
        with self.assertRaises(HTTPException) as raised:
            require_cycle_unlinkable("EXECUTION_IN_PROGRESS")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("cannot be unlinked", raised.exception.detail)

    def test_cycle_can_be_changed_during_test_design(self):
        require_cycle_unlinkable("TEST_DESIGN")

    def test_cycle_can_be_unlinked_before_execution(self):
        require_cycle_unlinkable("PLANNING")

    def test_qa_completion_requires_a_linked_cycle(self):
        with self.assertRaises(HTTPException) as raised:
            require_cycles_completed([])

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("requires a linked Test Cycle", raised.exception.detail)

    def test_qa_completion_rejects_an_open_cycle(self):
        cycle = SimpleNamespace(cycle_key="TC-17", status="In Progress")

        with self.assertRaises(HTTPException) as raised:
            require_cycles_completed([cycle])

        self.assertIn("TC-17 (In Progress)", raised.exception.detail)

    def test_qa_completion_accepts_completed_cycles(self):
        require_cycles_completed([SimpleNamespace(cycle_key="TC-17", status="Completed")])


if __name__ == "__main__":
    unittest.main()
