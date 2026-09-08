from types import SimpleNamespace

from app.routers.test_repository import _build_step_diffs


def step(number, text, expected):
    return SimpleNamespace(step_no=number, step_text=text, expected_result=expected)


def test_step_only_in_newer_version_is_reported_as_added():
    differences = _build_step_diffs(
        [step(1, "Open page", "Page opens")],
        [step(1, "Open page", "Page opens"), step(5, "Submit", "Saved")],
    )

    assert differences[5] == {
        "change_type": "added",
        "left": None,
        "right": {"step_text": "Submit", "expected_result": "Saved"},
    }


def test_step_only_in_older_version_is_reported_as_removed():
    differences = _build_step_diffs([step(5, "Submit", "Saved")], [])

    assert differences[5]["change_type"] == "removed"
    assert differences[5]["right"] is None


def test_step_present_on_both_sides_is_reported_as_modified():
    differences = _build_step_diffs(
        [step(5, "Submit", "Saved")],
        [step(5, "Submit form", "Confirmation appears")],
    )

    assert differences[5]["change_type"] == "modified"


def test_unchanged_step_is_not_returned_as_a_difference():
    same = step(5, "Submit", "Saved")

    assert _build_step_diffs([same], [same]) == {}
