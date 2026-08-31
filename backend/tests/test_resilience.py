import unittest

from app.resilience import CircuitBreaker, CircuitOpenError


class ManualClock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class CircuitBreakerTests(unittest.TestCase):
    def setUp(self):
        self.clock = ManualClock()
        self.breaker = CircuitBreaker("test", failure_threshold=3, recovery_seconds=20, clock=self.clock)

    def test_opens_after_consecutive_failures_and_fails_fast(self):
        self.breaker.check()
        self.breaker.record_failure()
        self.breaker.record_failure()
        self.breaker.record_failure()

        with self.assertRaises(CircuitOpenError) as raised:
            self.breaker.check()
        self.assertEqual(raised.exception.retry_after_seconds, 20)
        self.assertEqual(self.breaker.snapshot().state, "open")

    def test_single_half_open_probe_recovers_after_success(self):
        for _ in range(3):
            self.breaker.record_failure()
        self.clock.advance(20)

        self.breaker.check()  # the only permitted recovery probe
        with self.assertRaises(CircuitOpenError):
            self.breaker.check()
        self.breaker.record_success()

        self.breaker.check()
        self.assertEqual(self.breaker.snapshot().state, "closed")
        self.assertEqual(self.breaker.snapshot().consecutive_failures, 0)

    def test_failed_half_open_probe_reopens_for_full_cooldown(self):
        for _ in range(3):
            self.breaker.record_failure()
        self.clock.advance(20)
        self.breaker.check()
        self.breaker.record_failure()

        with self.assertRaises(CircuitOpenError) as raised:
            self.breaker.check()
        self.assertEqual(raised.exception.retry_after_seconds, 20)


if __name__ == "__main__":
    unittest.main()
