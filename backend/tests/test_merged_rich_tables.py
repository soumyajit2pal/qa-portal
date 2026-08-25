import base64
import json
import unittest

from reportlab.platypus import Table

from app.pdf_export import _decode_merged_table, _rich_text_flowables


def merged_table_block(payload: dict) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    return f"[qap-merged-table:v1:{encoded}]"


class MergedRichTableTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "rows": [
                [{"t": "TASK LIST", "c": 5, "h": True}],
                [
                    {"t": "MY TASKS", "h": True},
                    {"t": "START DATE", "h": True},
                    {"t": "DUE DATE", "h": True},
                    {"t": "% COMPLETE", "h": True},
                    {"t": "NOTES", "h": True},
                ],
                [
                    {"t": "Task", "r": 2},
                    {"t": "Date"},
                    {"t": "Date"},
                    {"t": "0%"},
                    {"t": "Initial"},
                ],
                [
                    {"t": "Date"},
                    {"t": "Date"},
                    {"t": "50%"},
                    {"t": "Follow-up"},
                ],
            ]
        }
        self.block = merged_table_block(self.payload)

    def test_decodes_column_and_row_spans(self):
        decoded = _decode_merged_table(self.block)
        self.assertIsNotNone(decoded)
        self.assertEqual(decoded["rows"][0][0]["c"], 5)
        self.assertEqual(decoded["rows"][2][0]["r"], 2)
        self.assertEqual(decoded["rows"][0][0]["t"], "TASK LIST")

    def test_pdf_flowable_contains_native_span_commands(self):
        flowables = _rich_text_flowables(self.block, available_width=400)
        self.assertEqual(len(flowables), 1)
        self.assertIsInstance(flowables[0], Table)
        self.assertIn(("SPAN", (0, 0), (4, 0)), flowables[0]._spanCmds)
        self.assertIn(("SPAN", (0, 2), (0, 3)), flowables[0]._spanCmds)

    def test_rejects_invalid_payload(self):
        self.assertIsNone(_decode_merged_table("[qap-merged-table:v1:not-json]"))

    def test_conflicting_rowspans_do_not_expand_four_columns_to_six(self):
        conflict = merged_table_block({"rows": [
            [
                {"t": "LABEL", "r": 2}, {"t": "tst", "r": 2},
                {"t": "TEST 2"}, {"t": "DATA 2"},
            ],
            [{"t": "1"}, {"t": "2"}, {"t": "33"}, {"t": "4"}],
            [{"t": "1"}, {"t": "2"}, {"t": "3"}, {"t": "4"}],
        ]})
        decoded = _decode_merged_table(conflict)
        self.assertEqual(decoded["rows"][0][0]["r"], 1)
        self.assertEqual(decoded["rows"][0][1]["r"], 1)
        table = _rich_text_flowables(conflict, available_width=400)[0]
        self.assertEqual(len(table._colWidths), 4)


if __name__ == "__main__":
    unittest.main()
