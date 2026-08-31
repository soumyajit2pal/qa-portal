"""Shared server-side pagination utilities (SRS 7.2, PAG-001..010).

Every list endpoint in this app used to run an unrestricted `.all()` query
and hand the complete result set to the frontend, which then did its own
client-side filtering/pagination (see `components/Common.tsx`'s `Table`).
This module is the one place implementing the standard contract every
paginated endpoint now follows: `page`/`page_size`/`search`/`status`/
`department`/`sort_by`/`sort_order` query params (PAG-001), page-size
clamping (PAG-002), the fixed response envelope (PAG-003), and a stable
secondary sort on the primary key (PAG-004).

A router using this module follows the same shape every time:

    params = Depends(PageParams)
    q = db.query(models.Foo)
    q = apply_search(q, params, models.Foo.title, models.Foo.foo_id)
    q = apply_status_filter(q, params, models.Foo.status)
    q = apply_department_filter(q, params, models.Foo.department)
    # ... any module-specific filters, all applied to `q` before pagination ...
    q = apply_sort(q, params, sortable={"title": models.Foo.title}, default_column=models.Foo.created_at, id_column=models.Foo.id)
    result = paginate(q, params)
    return to_page_response(result, params)

Authorization/department-scope filters (PAG-009) must be applied to `q`
the same way -- before `paginate()` runs the count -- so the total always
matches what the current user is actually allowed to see. This module
never applies authorization itself; it has no opinion on any entity's
access rules, only on how a filtered, authorized, sorted query becomes a
page of results.
"""
import datetime
from typing import Generic, List, Optional, TypeVar
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, asc, desc, or_
from sqlalchemy.orm import Query as SAQuery

T = TypeVar("T")

# PAG-002
DEFAULT_PAGE_SIZE = 5
ALLOWED_PAGE_SIZES = (5, 10, 25, 50, 100)
MAX_PAGE_SIZE = 100


class PageParams:
    """FastAPI dependency for the PAG-001 standard parameters. `search`/
    `status`/`department`/`sort_by` are deliberately plain here (no fixed
    choices enforced at this layer) -- each router knows its own
    searchable columns, valid statuses, and sortable fields, and applies
    them via the helpers below. `sort_by` in particular is only ever
    resolved through an explicit allow-list dict in `apply_sort` (never
    used to build a raw column reference), so it can never reach an
    arbitrary/unindexed/sensitive column no matter what a caller sends."""

    def __init__(
        self,
        page: int = Query(1, ge=1, description="Page number, starting from 1"),
        page_size: int = Query(DEFAULT_PAGE_SIZE, description="Records per page (5, 10, 25, 50, or 100)"),
        search: Optional[str] = Query(None, description="Free-text search"),
        status: Optional[List[str]] = Query(None, description="One or more status filters"),
        department: Optional[str] = Query(None, description="Department filter, where authorized"),
        raised_from: Optional[str] = Query(None, description="Optional IST raised-date range start for terminal history"),
        raised_to: Optional[str] = Query(None, description="Optional IST raised-date range end for terminal history"),
        sort_by: Optional[str] = Query(None, description="Approved sorting field"),
        sort_order: str = Query("desc", pattern="^(asc|desc)$"),
    ):
        # PAG-002: "Invalid or excessive page sizes shall return a
        # validation error or be safely restricted to the configured
        # maximum." An over-large request is silently clamped down to the
        # max (asking for "as many as possible" is a reasonable, harmless
        # request); anything else nonstandard is rejected outright rather
        # than silently served as some other page size the caller didn't
        # ask for.
        if page_size > MAX_PAGE_SIZE:
            page_size = MAX_PAGE_SIZE
        elif page_size not in ALLOWED_PAGE_SIZES:
            raise HTTPException(400, f"page_size must be one of {ALLOWED_PAGE_SIZES} (or omitted for the default of {DEFAULT_PAGE_SIZE})")
        self.page = page
        self.page_size = page_size
        self.search = search.strip() if search and search.strip() else None
        self.status = status or None
        self.department = department
        self.raised_from = raised_from.strip() if raised_from and raised_from.strip() else None
        self.raised_to = raised_to.strip() if raised_to and raised_to.strip() else None
        self.sort_by = sort_by.strip() if sort_by else None
        self.sort_order = sort_order


class Page(BaseModel, Generic[T]):
    """PAG-003's exact response contract."""
    items: List[T]
    page: int
    page_size: int
    total: int
    total_pages: int
    has_next: bool
    has_previous: bool
    # Present for keyset/cursor-backed lists. Existing offset clients can
    # ignore it and keep using the same response envelope.
    next_cursor: Optional[int] = None


class PaginationResult:
    __slots__ = ("items", "total", "total_pages")

    def __init__(self, items, total: int, total_pages: int):
        self.items = items
        self.total = total
        self.total_pages = total_pages


def apply_search(query: SAQuery, params: PageParams, *columns) -> SAQuery:
    """PAG-007 -- `search` (if present) is matched case-insensitively
    across the given columns, always in the database, never by
    downloading rows and matching them in Python."""
    if not params.search or not columns:
        return query
    like = f"%{params.search}%"
    return query.filter(or_(*[column.ilike(like) for column in columns]))


def apply_status_filter(query: SAQuery, params: PageParams, status_column) -> SAQuery:
    """PAG-001's `status` is "one or more" -- an IN filter, not equality."""
    if not params.status:
        return query
    return query.filter(status_column.in_(params.status))


def apply_department_filter(query: SAQuery, params: PageParams, department_column) -> SAQuery:
    """The explicit `department` query param is a further, optional narrowing
    a caller can apply on top of whatever authorization scoping the router
    already applied (e.g. `deps.dashboard_department_scope`) -- it is not
    itself an authorization control, so routers must still apply their own
    department/role scoping to `query` separately, before this."""
    if not params.department:
        return query
    return query.filter(department_column == params.department)


def _raised_date_bound(value: str, *, end: bool) -> datetime.datetime:
    """Parse an API date/datetime into an IST wall-clock value for Oracle."""
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(422, "Raised date must be ISO-8601 (YYYY-MM-DD or datetime).") from exc
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(ZoneInfo("Asia/Kolkata")).replace(tzinfo=None)
    if len(value) == 10:
        parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999) if end else parsed.replace(hour=0, minute=0, second=0, microsecond=0)
    return parsed


def apply_terminal_raised_date_filter(query: SAQuery, params: PageParams, status_column, created_at_column, terminal_statuses) -> SAQuery:
    """Filter historical terminal rows by raised date without hiding live work.

    The optional list-page date range is deliberately *not* a blanket filter:
    every Draft, active, returned, assigned and pending request remains in the
    result set regardless of age. Only terminal history is narrowed. This
    prevents an old but still-actionable request from disappearing from an
    operational queue merely because a user is reviewing recent history.
    """
    if not params.raised_from and not params.raised_to:
        return query
    start = _raised_date_bound(params.raised_from, end=False) if params.raised_from else None
    end = _raised_date_bound(params.raised_to, end=True) if params.raised_to else None
    if start and end and start > end:
        raise HTTPException(422, "Raised-date From cannot be after To.")
    terminal = tuple(getattr(status, "value", status) for status in terminal_statuses)
    historical_conditions = [status_column.in_(terminal)]
    if start:
        historical_conditions.append(created_at_column >= start)
    if end:
        historical_conditions.append(created_at_column <= end)
    return query.filter(or_(status_column.is_(None), status_column.notin_(terminal), and_(*historical_conditions)))


def apply_sort(query: SAQuery, params: PageParams, sortable: dict, default_column, id_column) -> SAQuery:
    """PAG-004 stable sort. `sortable` maps the public `sort_by` values a
    router accepts to real ORM columns -- an allow-list, so `sort_by` can
    never resolve to a column the router didn't explicitly offer. An
    unrecognised or omitted `sort_by` falls back to `default_column`. The
    primary key is always appended as a secondary sort key so rows sharing
    an identical value in the primary sort column still come back in a
    stable order across pages (PAG-004's own example:
    `ORDER BY created_at DESC, id DESC`)."""
    column = sortable.get(params.sort_by, default_column) if params.sort_by else default_column
    direction = desc if params.sort_order == "desc" else asc
    return query.order_by(direction(column), direction(id_column))


def paginate(query: SAQuery, params: PageParams) -> PaginationResult:
    """PAG-008 -- runs `query` (already filtered, authorized, and sorted by
    the caller) through the standard count-then-slice pattern. The count
    uses the exact same filtered/authorized query as the data page, so the
    total can never disagree with what the current user is actually
    allowed to see (PAG-009) or with whatever search/status/department
    filters are active. `order_by(None)` drops the ORDER BY for the count
    query specifically -- ordering is meaningless for a COUNT and dropping
    it keeps that query as cheap as possible (PAG-008's "optimized
    independently where required")."""
    total = query.order_by(None).count()
    offset = (params.page - 1) * params.page_size
    items = query.offset(offset).limit(params.page_size).all()
    total_pages = max(1, -(-total // params.page_size)) if params.page_size else 1  # ceil division
    return PaginationResult(items=items, total=total, total_pages=total_pages)


def to_page_response(result: PaginationResult, params: PageParams) -> dict:
    """Assembles the PAG-003 envelope. Returns a plain dict (not a `Page`
    instance) so FastAPI's own `response_model=Page[SomeListOut]` on the
    endpoint does the ORM-object -> Pydantic-model conversion for `items`
    the same way every other endpoint in this app already relies on
    (`ORMModel`'s `from_attributes=True`)."""
    return {
        "items": result.items,
        "page": params.page,
        "page_size": params.page_size,
        "total": result.total,
        "total_pages": result.total_pages,
        "has_next": params.page < result.total_pages,
        "has_previous": params.page > 1,
        "next_cursor": None,
    }


def paginate_by_id(query: SAQuery, params: PageParams, id_column, cursor: Optional[int]) -> dict:
    """Oracle-friendly keyset pagination for growth-unbounded tables.

    Cursor mode deliberately orders on the stable numeric primary key. It
    fetches one extra row to determine ``has_next`` and never uses OFFSET.
    An exact total is retained for the existing table footer; consumers that
    no longer need totals can later move that aggregate to a cached summary.
    """
    total = query.order_by(None).count()
    descending = params.sort_order == "desc"
    if cursor is not None:
        query = query.filter(id_column < cursor if descending else id_column > cursor)
    direction = desc if descending else asc
    rows = query.order_by(None).order_by(direction(id_column)).limit(params.page_size + 1).all()
    has_next = len(rows) > params.page_size
    items = rows[:params.page_size]
    total_pages = max(1, -(-total // params.page_size)) if params.page_size else 1
    return {
        "items": items,
        "page": params.page,
        "page_size": params.page_size,
        "total": total,
        "total_pages": total_pages,
        "has_next": has_next,
        "has_previous": params.page > 1,
        "next_cursor": items[-1].id if has_next and items else None,
    }
