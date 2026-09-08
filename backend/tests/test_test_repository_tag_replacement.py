from types import SimpleNamespace

from app.routers.test_repository import _replace_case_tags


class RecordingDb:
    def __init__(self, case):
        self.case = case
        self.flush_snapshots = []

    def flush(self):
        self.flush_snapshots.append([row.tag for row in self.case.tag_rows])


def test_unchanged_tags_do_not_generate_replacement_writes():
    existing_rows = [SimpleNamespace(tag="smoke"), SimpleNamespace(tag="regression")]
    case = SimpleNamespace(tag_rows=existing_rows.copy())
    db = RecordingDb(case)

    _replace_case_tags(db, case, ["regression", "smoke", "SMOKE"])

    assert db.flush_snapshots == []
    assert case.tag_rows == existing_rows


def test_changed_tags_delete_and_flush_before_inserting_replacements():
    case = SimpleNamespace(tag_rows=[SimpleNamespace(tag="smoke")])
    db = RecordingDb(case)

    _replace_case_tags(db, case, ["regression", "api"])

    assert db.flush_snapshots == [[]]
    assert [row.tag for row in case.tag_rows] == ["regression", "api"]
