import unittest
from unittest.mock import patch

from app.pdf_export import StructuredTableValue, _structured_table, build_request_detail_pdf


class SuppressionPdfLayoutTests(unittest.TestCase):
    def test_findings_render_as_a_structured_four_column_table(self):
        value = StructuredTableValue(
            headers=("Issue Group", "Severity", "Description", "Justification"),
            rows=[("FND-01", "High", "Validation finding", "Approved compensating control")],
            width_ratios=(.17, .13, .32, .38),
        )
        table = _structured_table(value, 500)
        self.assertEqual([cell.text for cell in table._cellvalues[0]], list(value.headers))
        self.assertEqual(len(table._cellvalues[1]), 4)
        self.assertEqual(table._colWidths, [85, 65, 160, 190])

        with patch("app.pdf_export._structured_table", wraps=_structured_table) as render_table:
            pdf = build_request_detail_pdf(
                title="TQA-SUP-01 - Test Application",
                subtitle="Suppression / False Positive Request - Full Detail Export",
                sections=[("Findings Covered", [("Findings", value)])],
                history=[],
                generated_by="Test User",
                generated_at="2026-09-05 21:30 IST",
            )
        self.assertTrue(pdf.getvalue().startswith(b"%PDF"))
        self.assertEqual(render_table.call_count, 1)


if __name__ == "__main__":
    unittest.main()
