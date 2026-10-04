"""Dedicated Oracle outbox delivery and shared, renewable SLA scheduling.

Run with ``python -m app.notification_worker``. Redis is a wake/scheduling
layer; losing it never loses committed email. Every worker periodically
recovers the Oracle outbox, whose atomic claims arbitrate parallel senders.
"""
import argparse
import logging
import os
import signal
import threading
import time
from pathlib import Path

from . import email_notifications as mail
from . import sla_notifications
from .redis_runtime import acquire_lease, coordination_key, get_client, release_lease, renew_lease

logger = logging.getLogger('qa_portal.notification_worker')
OUTBOX_POLL_SECONDS = 60
SLA_INTERVAL_SECONDS = 3600
SLA_LEASE_SECONDS = 120
SLA_RENEW_SECONDS = 30
_FENCE_SLA_DUE = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
"""


def _heartbeat_path():
    return Path(os.getenv('NOTIFICATION_WORKER_HEARTBEAT_FILE', '/tmp/qualityops-notification-worker-heartbeat'))


def write_heartbeat():
    path = _heartbeat_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temporary.write_text(str(time.time()), encoding='utf-8')
    os.replace(temporary, path)


def healthy():
    try:
        heartbeat = float(_heartbeat_path().read_text(encoding='utf-8'))
        return 0 <= time.time() - heartbeat <= 90
    except (OSError, ValueError):
        return False


class NotificationWorker:
    def __init__(self, stop_event=None):
        self.stop_event = stop_event or threading.Event()
        self.last_delivery = None

    def _consume_wake(self):
        try:
            return bool(get_client().getdel(coordination_key('notifications:wake')))
        except Exception:
            return False

    def _queue_sla_if_due(self):
        if not mail._enabled():
            return
        lease_key = coordination_key('notifications:sla:lease')
        due_key = coordination_key('notifications:sla:next')
        try:
            token = acquire_lease(lease_key, SLA_LEASE_SECONDS)
        except Exception:
            logger.warning('SLA coordination unavailable; deferring the scan')
            return
        if token is None:
            return
        finished = threading.Event()
        lost = threading.Event()

        def renew():
            while not finished.wait(SLA_RENEW_SECONDS):
                try:
                    if not renew_lease(lease_key, token, SLA_LEASE_SECONDS):
                        lost.set()
                        return
                except Exception:
                    lost.set()
                    return

        heartbeat = None
        try:
            due = get_client().get(due_key)
            if due is not None and float(due) > time.time():
                return
            if self.stop_event.is_set():
                return
            heartbeat = threading.Thread(target=renew, name='sla-lease-renewal', daemon=True)
            heartbeat.start()
            sla_notifications.queue_breaches(
                continue_running=lambda: not lost.is_set() and not self.stop_event.is_set())
            if lost.is_set() or self.stop_event.is_set():
                logger.warning('SLA scan interrupted after scheduler ownership was lost or shutdown requested')
                return
            # Check ownership synchronously too: a fast scan can finish before
            # the first heartbeat, or its last DB call can outlive the lease.
            if not renew_lease(lease_key, token, SLA_LEASE_SECONDS):
                return
            get_client().eval(_FENCE_SLA_DUE, 2, lease_key, due_key, token,
                             str(time.time() + SLA_INTERVAL_SECONDS), SLA_INTERVAL_SECONDS + 120)
        except Exception:
            logger.exception('SLA scheduler pass failed; the durable markers remain available for retry')
        finally:
            finished.set()
            if heartbeat is not None:
                heartbeat.join(timeout=1)
            try:
                release_lease(lease_key, token)
            except Exception:
                logger.warning('SLA scheduler lease release unavailable; lease will expire')

    def run_once(self):
        now = time.monotonic()
        wake = self._consume_wake()
        if wake or self.last_delivery is None or now - self.last_delivery >= OUTBOX_POLL_SECONDS:
            self.last_delivery = now
            # A bounded larger batch keeps email moving while containing each
            # worker's DB/SMTP occupancy. Failed recipients remain retry rows.
            mail.deliver_pending(limit=100)

    def run(self):
        # A large SLA pass must not postpone newly committed workflow email.
        def schedule_sla():
            while not self.stop_event.is_set():
                self._queue_sla_if_due()
                self.stop_event.wait(OUTBOX_POLL_SECONDS)

        scheduler = threading.Thread(target=schedule_sla, name='sla-scheduler', daemon=True)
        def heartbeat():
            while not self.stop_event.is_set():
                try:
                    write_heartbeat()
                except Exception:
                    logger.exception('Notification worker heartbeat could not be persisted')
                self.stop_event.wait(5)

        heartbeater = threading.Thread(target=heartbeat, name='notification-heartbeat', daemon=True)
        heartbeater.start()
        scheduler.start()
        try:
            while not self.stop_event.is_set():
                try:
                    self.run_once()
                except Exception:
                    logger.exception('Notification worker pass failed; the outbox will be retried')
                self.stop_event.wait(1)
        finally:
            scheduler.join(timeout=2)
            heartbeater.join(timeout=1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--healthcheck', action='store_true')
    args = parser.parse_args(argv)
    if args.healthcheck:
        raise SystemExit(0 if healthy() else 1)
    from .logging_config import configure_logging
    configure_logging()
    if mail.notification_worker_mode() != 'dedicated':
        raise RuntimeError('The notification worker requires NOTIFICATION_WORKER_MODE=dedicated')
    ready, reason = mail.smtp_readiness()
    if not ready:
        logger.warning('Notification worker idle: SMTP is disabled or incomplete (%s)', reason)
    # SLA/outbox actions use the same transactional listener as the web API.
    # Dedicated mode makes its after-commit hook a bounded Redis wake hint.
    mail.install_outbox_listener()
    worker = NotificationWorker()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: worker.stop_event.set())
    worker.run()


if __name__ == '__main__':
    main()
