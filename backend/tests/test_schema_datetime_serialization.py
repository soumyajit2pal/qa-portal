import datetime
import json

from app import schemas


class TimestampOut(schemas.ORMModel):
    occurred_at: datetime.datetime


class TimestampEnvelopeOut(schemas.ORMModel):
    created_at: datetime.datetime
    nested: TimestampOut


def test_orm_model_json_serializes_naive_datetime_as_ist_wall_clock():
    payload = TimestampOut(occurred_at=datetime.datetime(2026, 9, 20, 10, 15, 30))

    assert json.loads(payload.model_dump_json()) == {
        "occurred_at": "2026-09-20T10:15:30+05:30",
    }
    assert payload.model_dump(mode="json") == {
        "occurred_at": "2026-09-20T10:15:30+05:30",
    }


def test_orm_model_json_converts_aware_datetime_to_ist_in_nested_models():
    payload = TimestampEnvelopeOut(
        created_at=datetime.datetime(2026, 9, 20, 4, 45, 30, tzinfo=datetime.UTC),
        nested=TimestampOut(
            occurred_at=datetime.datetime(
                2026,
                9,
                20,
                12,
                15,
                30,
                tzinfo=datetime.timezone(datetime.timedelta(hours=7)),
            ),
        ),
    )

    assert json.loads(payload.model_dump_json()) == {
        "created_at": "2026-09-20T10:15:30+05:30",
        "nested": {"occurred_at": "2026-09-20T10:45:30+05:30"},
    }
