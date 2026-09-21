"""Read local source data and render a synthetic certificate; never commit."""
import asyncio
from pathlib import Path
from unittest.mock import patch
from app.database import SessionLocal
from app import models, certificate_summary, schemas
from app.routers.signoff import export_signoff

async def main():
    db = SessionLocal()
    try:
        source = db.query(models.FunctionalRequest).join(models.TestCycleChildRequestLink, models.TestCycleChildRequestLink.child_id == models.FunctionalRequest.id).filter(models.TestCycleChildRequestLink.child_type == 'Functional', models.FunctionalRequest.qa_request_id.isnot(None)).first()
        if source is None:
            source = db.query(models.FunctionalRequest).filter(models.FunctionalRequest.qa_request_id.isnot(None)).first()
        assert source and source.qa_request, 'A linked Functional Request is required'
        user = db.query(models.User).filter(models.User.is_active == True).first()
        obj = models.QASignOff(id=-1, certificate_id='REGRESSION-PREVIEW', certificate_type='Conditional Clearance',
            testing_type='Functional', testing_request_id=source.request_id, qa_workspace_id=source.qa_request.qa_workspace_id,
            application_name=source.qa_request.application_name, status='DRAFT', requester_id=user.id,
            certificate_date=models.today_ist(), environment_tested=None, build_number=None)
        # A transient object and a read-only session: no synthetic certificate is saved.
        data = certificate_summary.refresh(db, obj)
        certificate_summary.validate(obj, db)
        print('Snapshot captured and verified:', data['execution']['total'], 'executions;', data['defects']['total'], 'defects')
        with patch('app.routers.signoff._get_visible_or_404', return_value=obj):
            response = export_signoff(-1, db, user)
            chunks = [chunk async for chunk in response.body_iterator]
            Path('/private/tmp/qa-certificate-preview.pdf').write_bytes(b''.join(chunks))
        print('PDF rendered to /private/tmp/qa-certificate-preview.pdf; no records committed.')
    finally:
        db.rollback()
        db.close()

if __name__ == '__main__':
    asyncio.run(main())
