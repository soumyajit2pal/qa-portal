import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.email_notifications import _next_approver_roles, install_outbox_listener, smtp_readiness
from app.constants import GatewayStatus, QAStatus, Role


class EmailNotificationTests(unittest.TestCase):
    def test_smtp_is_disabled_by_default(self):
        with patch.dict(os.environ, {"SMTP_ENABLED": "false"}, clear=False):
            ready, reason = smtp_readiness()
        self.assertFalse(ready)
        self.assertEqual(reason, "SMTP_ENABLED is false")

    def test_smtp_requires_relay_and_sender(self):
        with patch.dict(os.environ, {"SMTP_ENABLED": "true", "SMTP_HOST": "", "SMTP_FROM_ADDRESS": ""}, clear=False):
            ready, reason = smtp_readiness()
        self.assertFalse(ready)
        self.assertIn("SMTP_HOST", reason)

    def test_pending_status_targets_the_correct_approver_group(self):
        self.assertEqual(_next_approver_roles(SimpleNamespace(status="SM_APPROVAL_PENDING")), {Role.SM})
        self.assertEqual(
            _next_approver_roles(SimpleNamespace(status="DEPARTMENT_HEAD_APPROVAL_PENDING")),
            {Role.DEPARTMENT_HEAD_CM, Role.DEPARTMENT_HEAD_AGM},
        )
        self.assertEqual(
            _next_approver_roles(models.QASignOff(status="SM_APPROVAL_PENDING")),
            {Role.QA_LEAD, Role.CHIEF_MANAGER_QA, Role.AGM_QA},
        )

    def test_workflow_action_creates_a_durable_recipient_outbox_item(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine, tables=[
            models.User.__table__, models.UserRole.__table__, models.UserDepartment.__table__,
            models.QARequest.__table__, models.FunctionalRequest.__table__, models.ApprovalAction.__table__, models.EmailNotification.__table__,
        ])
        db = sessionmaker(bind=engine)()
        try:
            requester = models.User(id=1, username="requester", full_name="Requester", email="requester@example.com", login_type="STANDARD")
            approver = models.User(id=2, username="sm", full_name="SM", email="sm@example.com", login_type="STANDARD")
            db.add_all([
                requester, approver,
                models.UserRole(user_id=2, role=Role.SM),
                models.UserDepartment(user_id=2, department="IT"),
            ])
            db.flush()
            db.add(models.QARequest(id=10, request_id="TQA-REQ-10", application_name="Portal", department="IT", requester_id=1, status=GatewayStatus.SUBMITTED))
            db.add(models.FunctionalRequest(
                id=20, request_id="TQA-FUNC-20", requester_id=1,
                qa_request_id=10, status=QAStatus.SM_APPROVAL_PENDING,
            ))
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST", entity_id=20, actor_id=1,
                step_name="SM Approval", decision="Submitted",
            ))
            install_outbox_listener()
            settings = {
                "SMTP_ENABLED": "true", "SMTP_HOST": "smtp.example.com",
                "SMTP_FROM_ADDRESS": "qa-portal@example.com", "SMTP_STARTTLS": "true", "SMTP_SSL": "false",
            }
            with patch.dict(os.environ, settings, clear=False), patch("app.email_notifications.deliver_pending_async"):
                db.commit()
            messages = db.query(models.EmailNotification).all()
            self.assertEqual([message.recipient_email for message in messages], ["sm@example.com"])
            self.assertIsNotNone(messages[0].approval_action_id)
            self.assertEqual(messages[0].approval_action.entity_type, "FUNCTIONAL_REQUEST")
            self.assertEqual(messages[0].status, "PENDING")
            self.assertIn("TQA-FUNC-20", messages[0].subject)
            self.assertIn("Record: TQA-FUNC-20", messages[0].body)
            self.assertNotIn("Record: #20", messages[0].body)
        finally:
            db.close()
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
