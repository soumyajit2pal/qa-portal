import pytest
from fastapi import HTTPException

from app.routers.dashboard import _date_bounds
from app.routers.reports import _period_bounds


@pytest.mark.parametrize("parser", [_date_bounds, _period_bounds])
def test_invalid_date_filter_is_a_client_error(parser):
    with pytest.raises(HTTPException) as raised:
        parser("not-a-date", None)

    assert raised.value.status_code == 400
    assert "ISO" in raised.value.detail


@pytest.mark.parametrize("parser", [_date_bounds, _period_bounds])
def test_reversed_date_filter_is_rejected(parser):
    with pytest.raises(HTTPException) as raised:
        parser("2026-09-20", "2026-09-19")

    assert raised.value.status_code == 400
    assert "date_from" in raised.value.detail
