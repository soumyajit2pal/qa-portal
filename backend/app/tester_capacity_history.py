"""Recorded occupancy, integrating request-load intervals over IST calendar days."""
import datetime
from collections import defaultdict
from zoneinfo import ZoneInfo

from sqlalchemy import String, case, cast, func, insert, literal, or_, select

from . import models
from .tester_capacity import (
    TESTER_CAPACITY_POINTS, FUNCTIONAL_TESTER_LOAD, PERFORMANCE_TESTER_LOAD,
    SECURITY_ANALYST_LOAD, _assigned_user_ids,
)

TRACKING_KEY = 'occupancy-v1'


def sources():
    return (
        (models.FunctionalRequest, 'FUNCTIONAL_REQUEST', 'assigned_tester_ids', FUNCTIONAL_TESTER_LOAD),
        (models.PerformanceRequest, 'PERFORMANCE_REQUEST', 'assigned_tester_ids', PERFORMANCE_TESTER_LOAD),
        (models.SASTRequest, 'SAST_REQUEST', 'security_analyst_id', SECURITY_ANALYST_LOAD),
        (models.DASTRequest, 'DAST_REQUEST', 'security_analyst_id', SECURITY_ANALYST_LOAD),
    )


def wall_time(value):
    return models.as_aware(value).astimezone(ZoneInfo('Asia/Kolkata')).replace(tzinfo=None)


def seed_tracking(connection, *, observed_at=None, check_existing=True):
    """Migration baseline: today's state is recorded only from this instant."""
    table = models.TesterCapacityEvent.__table__
    if check_existing and connection.execute(
        select(table.c.id).where(table.c.tracking_key == TRACKING_KEY),
    ).scalar() is not None:
        return
    observed_at = wall_time(observed_at or models.now())
    connection.execute(insert(table).inline().values(
        tracking_key=TRACKING_KEY, entity_type='TRACKING_STARTED', entity_id=0,
        load_points=0, capacity_points=TESTER_CAPACITY_POINTS, observed_at=observed_at,
    ))
    for model, entity_type, assignment_field, loads in sources():
        source = model.__table__
        connection.execute(insert(table).from_select(
            ['entity_type', 'entity_id', 'qa_request_id', 'status', 'assignee_ids',
             'load_points', 'capacity_points', 'observed_at'],
            select(literal(entity_type), source.c.id, source.c.qa_request_id,
                   source.c.status, cast(source.c[assignment_field], String(1000)),
                   case(loads, value=source.c.status, else_=0.0),
                   literal(TESTER_CAPACITY_POINTS), literal(observed_at)),
        ))


def capture_request(connection, target, *, deleted=False):
    for model, entity_type, assignment_field, loads in sources():
        if isinstance(target, model):
            raw = getattr(target, assignment_field)
            assignee_ids = str(raw) if raw is not None else None
            connection.execute(insert(models.TesterCapacityEvent).inline().values(
                entity_type=entity_type, entity_id=target.id,
                qa_request_id=target.qa_request_id, status='DELETED' if deleted else target.status,
                assignee_ids=None if deleted else assignee_ids,
                load_points=0.0 if deleted else loads.get(target.status, 0.0),
                capacity_points=TESTER_CAPACITY_POINTS, observed_at=wall_time(models.now()),
            ))
            return


def daily_trend(events, testers, start, end, tracking_started_at, observed_until):
    days = []
    day = start.date()
    while day <= end.date():
        days.append(day)
        day += datetime.timedelta(days=1)
    known_start = max(start, tracking_started_at) if tracking_started_at else None
    known_end = min(end, observed_until)
    totals = {tester.id: defaultdict(lambda: [0.0, 0.0, 0.0]) for tester in testers}
    current = {tester.id: 0.0 for tester in testers}
    states = {}

    def apply(event):
        key = (event.entity_type, event.entity_id)
        previous = states.get(key, {})
        for user_id, percent in previous.items():
            current[user_id] -= percent
        ids = _assigned_user_ids(event.assignee_ids)
        percent = (100 * event.load_points / event.capacity_points / len(ids)
                   if ids and event.capacity_points > 0 else 0)
        states[key] = {user_id: percent for user_id in ids if user_id in current}
        for user_id, value in states[key].items():
            current[user_id] += value

    def integrate(left, right):
        while left < right:
            day_end = datetime.datetime.combine(left.date() + datetime.timedelta(days=1), datetime.time())
            stop = min(day_end, right)
            seconds = (stop - left).total_seconds()
            for user_id, value in current.items():
                value = max(0.0, value)
                daily = totals[user_id][left.date()]
                daily[0] += value * seconds
                daily[1] += seconds
                daily[2] = max(daily[2], value)
            left = stop

    if known_start is not None and known_start < known_end:
        cursor = known_start
        for event in sorted(events, key=lambda item: (wall_time(item.observed_at), item.id)):
            at = wall_time(event.observed_at)
            if at > known_end:
                break
            if at > cursor:
                integrate(cursor, at)
                cursor = at
            apply(event)
        integrate(cursor, known_end)

    result = []
    for tester in testers:
        points = []
        for day in days:
            weighted, seconds, peak = totals[tester.id].get(day, [0, 0, 0])
            points.append({
                'date': day.isoformat(),
                'average_occupancy': round(weighted / seconds, 1) if seconds else None,
                'peak_occupancy': round(peak, 1) if seconds else None,
                'recorded_hours': round(seconds / 3600, 2),
            })
        recorded = list(totals[tester.id].values())
        seconds = sum(item[1] for item in recorded)
        result.append({
            'tester_id': tester.id, 'tester_name': tester.full_name, 'points': points,
            'average_occupancy': round(sum(item[0] for item in recorded) / seconds, 1) if seconds else None,
            'peak_occupancy': round(max((item[2] for item in recorded), default=0), 1) if seconds else None,
            'high_occupancy_days': sum(1 for item in points if item['average_occupancy'] is not None and item['average_occupancy'] >= 80),
        })
    return result


def trend(db, testers, visible_requests, start, end, *, observed_until=None):
    event = models.TesterCapacityEvent
    observed_until = wall_time(observed_until or models.now())
    tracking_started_at = db.query(event.observed_at).filter(event.tracking_key == TRACKING_KEY).scalar()
    events = []
    if tracking_started_at is not None:
        scoped = db.query(event).filter(event.qa_request_id.in_(visible_requests))
        # One last observation per request before the reporting period, plus
        # changes inside it. An old active request still contributes its load.
        previous = scoped.filter(event.observed_at < start).with_entities(
            event.id.label('id'), func.row_number().over(
                partition_by=(event.entity_type, event.entity_id),
                order_by=(event.observed_at.desc(), event.id.desc()),
            ).label('position'),
        ).subquery()
        last_ids = select(previous.c.id).where(previous.c.position == 1)
        events = scoped.filter(
            event.observed_at <= min(end, observed_until),
            or_(event.observed_at >= start, event.id.in_(last_ids)),
        ).all()
    return {
        'tracking_started_at': models.as_aware(tracking_started_at).isoformat() if tracking_started_at else None,
        'observed_until': models.as_aware(observed_until).isoformat(),
        'period': {'date_from': models.as_aware(start).isoformat(), 'date_to': models.as_aware(end).isoformat()},
        'capacity_points': TESTER_CAPACITY_POINTS,
        'basis': 'time_weighted_daily_occupancy',
        'testers': daily_trend(events, testers, start, end,
                              wall_time(tracking_started_at) if tracking_started_at else None, observed_until),
    }
