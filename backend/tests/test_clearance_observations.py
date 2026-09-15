from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import json
import pytest
from app import models
from app.routers.signoff import export_signoff


@pytest.mark.parametrize('certificate_type', ['Conditional Clearance', 'Full Clearance'])
@pytest.mark.parametrize('manual, expected', [('User mitigation only', 'User mitigation only'), ('   ', 'SYSTEM-DEFECT')])
def test_section_f_uses_manual_content_or_frozen_system_observations(manual, expected, certificate_type):
    snapshot = {'revision': 1, 'captured_at': '2026-09-13', 'population_note': 'Test',
                'conditional_observations': manual,
                'observations': [{'defect_key': 'SYSTEM-DEFECT', 'functionality': 'Login',
                                  'observation': 'Failure', 'severity': 'Low', 'status': 'Deferred',
                                  'owner': 'Owner', 'target_date': 'Tomorrow'}]}
    obj = models.QASignOff(id=1, certificate_id='TEST', application_name='Test', status='DRAFT', certificate_type=certificate_type,
                          conditional_observations='Unsaved live content',
                          certificate_data_json=json.dumps({'current': snapshot}))
    db = MagicMock()
    db.query.return_value.filter_by.return_value.order_by.return_value.all.return_value = []
    with patch('app.routers.signoff._get_visible_or_404', return_value=obj), \
         patch('app.routers.signoff.certificate_summary.markdown_tables', return_value=[]), \
         patch('app.routers.signoff.build_request_detail_pdf', return_value=BytesIO(b'%PDF')) as render:
        export_signoff(1, db, SimpleNamespace(full_name='Tester'))
    sections = dict(render.call_args.kwargs['sections'])
    if certificate_type != 'Conditional Clearance':
        assert 'Section F – Conditional Clearance Observations' not in sections
        return
    fields = sections['Section F – Conditional Clearance Observations']
    text = str(fields)
    assert expected in text
    assert 'Unsaved live content' not in text
    if manual.strip():
        assert 'SYSTEM-DEFECT' not in text
    assert [label for label, _ in sections['Section E – QA Clearance Remarks']] == [
        'Testing Scope Completed', 'Open Risks (if any)', 'Known Limitations',
        'Business Acceptance Status', 'Security Testing Status', 'Deployment Recommendation', 'Remarks']
