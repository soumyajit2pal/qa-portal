"""Shared classification rules for QA intake and child-request corrections."""
from typing import Optional


def business_defect_number(value: Optional[str], change_type: Optional[str]) -> Optional[str]:
    if change_type != "Bug Fix":
        return None
    return (value or "").strip() or None
