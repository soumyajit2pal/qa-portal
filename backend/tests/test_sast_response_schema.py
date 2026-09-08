import datetime

from app import models, schemas


def _sast_request(*, qa_request_id=None):
    return models.SASTRequest(
        id=2441,
        request_id="TQA-SAST-2441",
        application_name="QA Portal",
        status="DRAFT",
        needs_dept_head_reapproval=False,
        qa_request_id=qa_request_id,
        created_at=datetime.datetime(2026, 9, 6, 12, 0),
        updated_at=datetime.datetime(2026, 9, 6, 12, 1),
    )


def test_sast_orm_response_serializes_with_qa_request_contract():
    result = schemas.SASTOut.model_validate(_sast_request(qa_request_id=42))

    assert result.qa_request_id == 42
    assert "linked_request_type" not in schemas.SASTOut.model_fields
    assert "linked_request_id" not in schemas.SASTOut.model_fields


def test_sast_orm_response_serializes_without_parent_for_legacy_rows():
    result = schemas.SASTOut.model_validate(_sast_request())

    assert result.qa_request_id is None
