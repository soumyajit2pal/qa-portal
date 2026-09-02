import unittest
from unittest.mock import patch

from app.pdf_export import (
    DIGITAL_SIGNATURE_NOTICE,
    QA_CLEARANCE_SIGNED_TYPE,
    SignatureValue,
    _signature_block,
    _signature_notice_block,
    build_request_detail_pdf,
    qa_clearance_export_status,
)


class QAClearanceSignatureExportTests(unittest.TestCase):
    def test_issued_status_uses_signed_export_label(self):
        self.assertEqual(qa_clearance_export_status("ISSUED"), QA_CLEARANCE_SIGNED_TYPE)
        self.assertEqual(qa_clearance_export_status("DRAFT"), "DRAFT")

    def test_signature_card_states_that_no_physical_signature_is_required(self):
        signature = SignatureValue(
            signer="QA Executive",
            signature_id="ESIG-123",
            applied_at="2026-09-02 10:00 IST",
            intent="Approve QA clearance",
            stage="Executive Approval",
            signature_type=QA_CLEARANCE_SIGNED_TYPE,
        )
        table = _signature_block("Executive Approval — Digital Signature", signature, 400)[1]
        text = "\n".join(
            getattr(cell, "text", str(cell))
            for row in table._cellvalues
            for cell in row
            if cell
        )

        self.assertIn(QA_CLEARANCE_SIGNED_TYPE.upper(), text)
        self.assertNotIn(DIGITAL_SIGNATURE_NOTICE, text)
        self.assertIn("ESIG-123", text)

        notice_table = _signature_notice_block(400)
        notice_text = "\n".join(
            getattr(cell, "text", str(cell))
            for row in notice_table._cellvalues
            for cell in row
            if cell
        )
        self.assertIn(DIGITAL_SIGNATURE_NOTICE, notice_text)

        # Rendering the complete document is still part of the regression:
        # the signature card must fit inside ReportLab's page layout.
        pdf = build_request_detail_pdf(
            title="TQA-SIGN-1",
            subtitle="QA Clearance Certificate",
            sections=[("QA Clearance Digital Signatures", [
                ("Executive Approval — Digital Signature", signature),
            ])],
            history=[],
            history_title=None,
            generated_by="Unit Test",
            generated_at="2026-09-02 10:01 IST",
        )
        self.assertTrue(pdf.getvalue().startswith(b"%PDF"))

    def test_shared_detail_exports_promote_recorded_signatures_to_cards(self):
        marker = (
            "Approved [Electronic signature | Signer: QA Lead | Applied: 2026-09-02T10:00:00+05:30 "
            "| Signature ID: ESIG-AUTO | Style: professional "
            "| Intent: I authorize this approval.]"
        )
        with patch("app.pdf_export._signature_block", wraps=_signature_block) as render_signature:
            pdf = build_request_detail_pdf(
                title="Functional Request",
                subtitle="Full Detail Export",
                sections=[],
                history=[("QA Lead Approval", "Approved", "QA Lead", "QA_LEAD", marker, "2026-09-02")],
                generated_by="Unit Test",
                generated_at="2026-09-02 10:01 IST",
            )

        self.assertTrue(pdf.getvalue().startswith(b"%PDF"))
        self.assertEqual(render_signature.call_count, 1)
        rendered_value = render_signature.call_args.args[1]
        self.assertEqual(rendered_value.signature_id, "ESIG-AUTO")
        self.assertEqual(rendered_value.signature_type, "Digitally Signed Approval")


if __name__ == "__main__":
    unittest.main()
