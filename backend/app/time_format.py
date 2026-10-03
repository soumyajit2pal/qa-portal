"""One timezone for portal timestamps, independent of the host timezone."""
from datetime import datetime, timedelta, timezone
import re

IST = timezone(timedelta(hours=5, minutes=30), name="IST")
_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?"
    r"(?:Z|[+-]\d{2}:?\d{2}| (?:IST|UTC))?$", re.I,
)


def as_ist(value: datetime) -> datetime:
    # Plain Oracle DateTime columns contain IST wall-clock values.
    return value.replace(tzinfo=IST) if value.tzinfo is None else value.astimezone(IST)


def parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return as_ist(value)
    if not isinstance(value, str) or not _TIMESTAMP.fullmatch(value.strip()):
        return None
    text = value.strip()
    if text.upper().endswith(" IST"):
        text = text[:-4] + "+05:30"
    elif text.upper().endswith(" UTC"):
        text = text[:-4] + "+00:00"
    try:
        return as_ist(datetime.fromisoformat(text.replace("z", "Z")))
    except ValueError:
        return None


def format_datetime_ist(value: datetime, *, separator: str = " ") -> str:
    applied = as_ist(value)
    clock = applied.strftime("%H:%M:%S")
    if applied.microsecond:
        clock += "." + f"{applied.microsecond:06d}".rstrip("0")
    return f"{applied.strftime('%d %b %Y')}{separator}{clock} IST"


def display_timestamp(value: object) -> object:
    """Format timestamp cells without changing ordinary text or numbers."""
    parsed = parse_timestamp(value)
    return format_datetime_ist(parsed) if parsed is not None else value
