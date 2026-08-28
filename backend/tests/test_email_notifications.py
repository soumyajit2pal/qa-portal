import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app import email_notifications
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

    def test_access_review_notification_targets_each_active_admin(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine, tables=[
            models.User.__table__, models.UserRole.__table__, models.UserDepartment.__table__,
            models.ApprovalAction.__table__, models.EmailNotification.__table__,
        ])
        db = sessionmaker(bind=engine)()
        try:
            document_user = models.User(
                id=1, username="vendor.user", full_name="Vendor User",
                email="vendor@example.com", department="Other", login_type="LDAP",
                role_assignments=[models.UserRole(role=Role.DOCUMENT_PORTAL_VIEWER)],
                department_assignments=[models.UserDepartment(department="Other")],
            )
            active_admin = models.User(id=2, username="admin", full_name="Admin", email="admin@example.com", login_type="STANDARD")
            inactive_admin = models.User(id=3, username="oldadmin", full_name="Old Admin", email="old@example.com", login_type="STANDARD", is_active=False)
            db.add_all([
                document_user, active_admin, inactive_admin,
                models.UserRole(user_id=2, role=Role.ADMIN),
                models.UserRole(user_id=3, role=Role.ADMIN),
            ])
            db.flush()
            settings = {"SMTP_ENABLED": "true", "SMTP_HOST": "smtp.example.com", "SMTP_FROM_ADDRESS": "qa-portal@example.com"}
            with patch.dict(os.environ, settings, clear=False):
                queued = email_notifications.queue_access_review_notifications(db, document_user)
            db.flush()
            messages = db.query(models.EmailNotification).all()
            self.assertEqual(queued, 1)
            self.assertEqual([message.recipient_email for message in messages], ["admin@example.com"])
            self.assertEqual(messages[0].approval_action.entity_type, "USER_ACCESS")
            self.assertIn("vendor.user", messages[0].subject)
            self.assertIn("Department: Other", messages[0].body)
        finally:
            db.close()
            engine.dispose()

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
            department_head = models.User(id=3, username="head", full_name="Department Head", email="head@example.com", login_type="STANDARD")
            db.add_all([
                requester, approver, department_head,
                models.UserRole(user_id=2, role=Role.SM),
                models.UserDepartment(user_id=2, department="IT"),
                models.UserRole(user_id=3, role=Role.DEPARTMENT_HEAD_CM),
                models.UserDepartment(user_id=3, department="IT"),
            ])
            db.flush()
            db.add(models.QARequest(id=10, request_id="TQA-REQ-10", application_name="Portal", department="IT", requester_id=1, status=GatewayStatus.SUBMITTED))
            db.add(models.FunctionalRequest(
                id=20, request_id="TQA-FUNC-20", requester_id=1,
                qa_request_id=10, status=QAStatus.SM_APPROVAL_PENDING,
            ))
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST", entity_id=20, actor_id=1,
                step_name="Requester", decision="Submitted",
            ))
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST", entity_id=20, actor_id=1,
                step_name="SM Approval", decision="Pending",
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
            self.assertIn("Action required", messages[0].subject)
            self.assertIn("Service Manager review", messages[0].body)
            self.assertIsNotNone(messages[0].html_body)
            self.assertIn("Open in QA Portal", messages[0].html_body)

            # When the SM completes their approval, only the next stage's
            # Department Head receives the next action-required email.
            functional = db.get(models.FunctionalRequest, 20)
            functional.status = QAStatus.DEPARTMENT_HEAD_APPROVAL_PENDING
            db.add(models.ApprovalAction(
                entity_type="FUNCTIONAL_REQUEST", entity_id=20, actor_id=2,
                step_name="SM Approval", decision="Approved",
            ))
            with patch.dict(os.environ, settings, clear=False), patch("app.email_notifications.deliver_pending_async"):
                db.commit()
            messages = db.query(models.EmailNotification).order_by(models.EmailNotification.id).all()
            self.assertEqual([message.recipient_email for message in messages], ["sm@example.com", "head@example.com"])
            self.assertIn("Department Head review", messages[1].body)
        finally:
            db.close()
            engine.dispose()

    def test_one_bad_recipient_does_not_stop_other_recipients(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine, tables=[models.ApprovalAction.__table__, models.EmailNotification.__table__])
        factory = sessionmaker(bind=engine)
        db = factory()
        try:
            action = models.ApprovalAction(entity_type="FUNCTIONAL_REQUEST", entity_id=20, step_name="SM Approval", decision="Pending")
            db.add(action)
            db.flush()
            db.add_all([
                models.EmailNotification(approval_action_id=action.id, recipient_email="bad@example.com", subject="Bad", body="Bad"),
                models.EmailNotification(approval_action_id=action.id, recipient_email="good@example.com", subject="Good", body="Good"),
            ])
            db.commit()

            def send(notification):
                if notification.recipient_email == "bad@example.com":
                    raise RuntimeError("SMTP recipient rejected")

            settings = {"SMTP_ENABLED": "true", "SMTP_HOST": "smtp.example.com", "SMTP_FROM_ADDRESS": "qa-portal@example.com"}
            with patch.dict(os.environ, settings, clear=False), patch.object(email_notifications, "SessionLocal", factory), patch.object(email_notifications, "_send", side_effect=send):
                self.assertEqual(email_notifications.deliver_pending(), 1)

            db.expire_all()
            rows = {row.recipient_email: row for row in db.query(models.EmailNotification).all()}
            self.assertEqual(rows["bad@example.com"].status, "RETRY")
            self.assertEqual(rows["good@example.com"].status, "SENT")
        finally:
            db.close()
            engine.dispose()

    def test_test_case_batch_creates_one_summary_per_recipient(self):
        engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(engine, tables=[
            models.User.__table__, models.UserRole.__table__, models.UserDepartment.__table__,
            models.ApplicationMaster.__table__, models.TestProject.__table__, models.TestCase.__table__,
            models.ApprovalAction.__table__, models.EmailNotification.__table__,
        ])
        db = sessionmaker(bind=engine)()
        try:
            author = models.User(id=1, username="author", full_name="Author", email="author@example.com", login_type="STANDARD")
            reviewer = models.User(id=2, username="qa", full_name="QA Reviewer", email="qa@example.com", login_type="STANDARD")
            db.add_all([
                author, reviewer,
                models.UserRole(user_id=2, role=Role.QA_ENGINEER),
                models.UserDepartment(user_id=2, department="COE - Quality Assurance"),
                models.TestProject(id=10, project_key="TQA-PRJ-10", name="Portal Tests", department="COE - Quality Assurance"),
                models.TestCase(id=20, test_case_key="TQA-TC-20", project_id=10, status="Recommendation Pending"),
                models.TestCase(id=21, test_case_key="TQA-TC-21", project_id=10, status="Recommendation Pending"),
                models.ApprovalAction(entity_type="TEST_CASE", entity_id=20, actor_id=1, step_name="Test Case Approval Workflow", decision="Submitted"),
                models.ApprovalAction(entity_type="TEST_CASE", entity_id=21, actor_id=1, step_name="Test Case Approval Workflow", decision="Submitted"),
            ])
            install_outbox_listener()
            settings = {"SMTP_ENABLED": "true", "SMTP_HOST": "smtp.example.com", "SMTP_FROM_ADDRESS": "qa-portal@example.com"}
            with patch.dict(os.environ, settings, clear=False), patch("app.email_notifications.deliver_pending_async"):
                db.commit()

            messages = db.query(models.EmailNotification).all()
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0].recipient_email, "qa@example.com")
            self.assertIn("2 Test Cases", messages[0].subject)
            self.assertIn("TQA-TC-20", messages[0].body)
            self.assertIn("TQA-TC-21", messages[0].body)
        finally:
            db.close()
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
