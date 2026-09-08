from app.testcase_imports import build_test_case_import_fingerprint


def _definition(scenario="User can sign in", step="Enter valid credentials", tags=None):
    return (
        {
            "epic_id": "EP-AUTH",
            "cr_number": "CR-101",
            "feature_id": "FE-LOGIN",
            "user_story_id": "US-1",
            "test_type": "Functional",
            "module_name": "Authentication",
            "test_scenario": scenario,
            "pre_condition": "User is active",
            "description": "Verify sign in",
            "priority": "High",
        },
        tags or ["smoke", "login"],
        [{"step_text": step, "expected_result": "Dashboard is displayed"}],
    )


def test_import_fingerprint_matches_reformatted_duplicate():
    content, tags, steps = _definition()
    duplicate_content, duplicate_tags, duplicate_steps = _definition(
        scenario="  USER   can sign in ",
        step="ENTER valid credentials",
        tags=["LOGIN", "smoke"],
    )

    assert build_test_case_import_fingerprint(content, steps) == build_test_case_import_fingerprint(
        duplicate_content, duplicate_steps
    )


def test_import_fingerprint_changes_when_test_behavior_changes():
    content, tags, steps = _definition()
    changed_content, changed_tags, changed_steps = _definition(step="Enter invalid credentials")

    assert build_test_case_import_fingerprint(content, steps) != build_test_case_import_fingerprint(
        changed_content, changed_steps
    )


def test_import_fingerprint_ignores_priority_and_tag_classification_changes():
    content, _tags, steps = _definition()
    changed_content = {**content, "priority": "Low"}

    assert build_test_case_import_fingerprint(content, steps) == build_test_case_import_fingerprint(
        changed_content, steps
    )
