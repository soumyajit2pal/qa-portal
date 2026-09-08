"""Pure helpers for safe, repeatable testcase imports."""

import hashlib
import json
from typing import List


TEST_CASE_IMPORT_CONTENT_FIELDS = (
    "epic_id", "cr_number", "feature_id", "user_story_id", "test_type", "module_name",
    "test_scenario", "pre_condition", "description", "priority",
)


def build_test_case_import_fingerprint(content: dict, steps: List[dict]) -> str:
    """Return a stable identity for one imported testcase definition.

    IDs and target folders are intentionally excluded: imports mint their
    own governed testcase ID, and moving the same definition to a different
    folder must not create a duplicate. Whitespace/case-only differences are
    normalized so a trivially reformatted workbook is still recognized.
    """
    def normalized(value) -> str:
        return " ".join(str(value or "").split()).casefold()

    payload = {
        # Priority and tags are repository metadata. Changing either must
        # update/classify the existing testcase, not create a second copy.
        "content": [
            normalized(content.get(field))
            for field in TEST_CASE_IMPORT_CONTENT_FIELDS
            if field != "priority"
        ],
        "steps": [
            [normalized(step.get("step_text")), normalized(step.get("expected_result"))]
            for step in steps
        ],
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()
