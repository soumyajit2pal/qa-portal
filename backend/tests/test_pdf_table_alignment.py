from unittest.mock import patch
from reportlab.platypus import Table
from app import pdf_export as pdf


def test_all_top_level_tables_use_frame_content_width_and_left_alignment():
    captured = []
    def build(doc, elements, **kwargs):
        captured.extend(elements)
        assert abs(pdf._CONTENT_WIDTH - (doc.width - 2 * pdf._FRAME_PADDING)) < .001
    with patch.object(pdf.SimpleDocTemplate, 'build', build):
        pdf.build_request_detail_pdf(
            title='Certificate', subtitle='QA', generated_by='Tester', generated_at='2026-09-17',
            sections=[('Evidence', [('Status', 'Draft'), ('Summary', pdf.RichTextValue('| Status | Count |\n| --- | --- |\n| Closed | 1 |\n\nEvidence note'))])],
            history=[('Review', 'Approved', 'QA Lead', 'QA_LEAD', 'Checked', '2026-09-17')],
        )
    tables = [item for item in captured if isinstance(item, Table)]
    assert len(tables) >= 5
    for table in tables:
        assert table.hAlign == 'LEFT'
        assert abs(sum(table._argW) - pdf._CONTENT_WIDTH) < .001
