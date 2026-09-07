// Wall-clock deadlines include time spent asleep. The worker polls every 30s;
// no menu catalog, UI thread, or network reachability observer is involved.
pub(crate) const CHECK_INTERVAL: u64 = 6 * 60 * 60;
pub(crate) const STARTUP_DELAY: u64 = 30;

#[derive(Debug)]
pub(crate) struct UpdateSchedule {
    pub(crate) enabled: bool,
    pub(crate) generation: u64,
    next_check_at: u64,
    last_observed: u64,
    failures: u32,
}

impl UpdateSchedule {
    pub(crate) fn new(now: u64, enabled: bool) -> Self {
        Self {
            enabled,
            generation: 0,
            next_check_at: now.saturating_add(STARTUP_DELAY),
            last_observed: now,
            failures: 0,
        }
    }

    pub(crate) fn set_enabled(&mut self, enabled: bool, now: u64) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        self.generation = self.generation.wrapping_add(1);
        self.failures = 0;
        self.last_observed = now;
        self.next_check_at = now.saturating_add(STARTUP_DELAY);
    }

    pub(crate) fn due(&mut self, now: u64) -> bool {
        if now < self.last_observed {
            self.next_check_at = now.saturating_add(STARTUP_DELAY);
        }
        self.last_observed = now;
        self.enabled && now >= self.next_check_at
    }

    pub(crate) fn finished(&mut self, now: u64, success: bool) {
        self.last_observed = now;
        let delay = if success {
            self.failures = 0;
            CHECK_INTERVAL
        } else {
            self.failures = self.failures.saturating_add(1);
            match self.failures {
                1 => 5 * 60,
                2 => 15 * 60,
                _ => 60 * 60,
            }
        };
        self.next_check_at = now.saturating_add(delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_then_six_hours() {
        let mut schedule = UpdateSchedule::new(100, true);
        assert!(!schedule.due(129));
        assert!(schedule.due(130));
        schedule.finished(140, true);
        assert!(!schedule.due(140 + CHECK_INTERVAL - 1));
        assert!(schedule.due(140 + CHECK_INTERVAL));
    }
    #[test]
    fn waking_after_deadline_checks_once_then_reschedules() {
        let mut schedule = UpdateSchedule::new(100, true);
        schedule.finished(130, true);
        let wake = 130 + 2 * CHECK_INTERVAL;
        assert!(schedule.due(wake));
        schedule.finished(wake, true);
        assert!(!schedule.due(wake + 30));
    }
    #[test]
    fn offline_retries_back_off_and_success_resets_them() {
        let mut schedule = UpdateSchedule::new(0, true);
        for (now, delay) in [(30, 300), (330, 900), (1230, 3600), (4830, 3600)] {
            schedule.finished(now, false);
            assert!(!schedule.due(now + delay - 1));
            assert!(schedule.due(now + delay));
        }
        schedule.finished(9000, true);
        schedule.finished(9001, false);
        assert!(schedule.due(9301));
    }
    #[test]
    fn disable_and_reenable_invalidates_inflight_generation() {
        let mut schedule = UpdateSchedule::new(0, true);
        let previous = schedule.generation;
        schedule.set_enabled(false, 40);
        assert!(!schedule.due(100000));
        assert_ne!(previous, schedule.generation);
        schedule.set_enabled(true, 100000);
        assert!(!schedule.due(100029));
        assert!(schedule.due(100030));
        let enabled_generation = schedule.generation;
        schedule.set_enabled(true, 100030);
        assert_eq!(enabled_generation, schedule.generation);
    }
    #[test]
    fn manual_check_resets_automatic_deadline_but_does_not_enable_it() {
        let mut schedule = UpdateSchedule::new(0, false);
        schedule.finished(30, true);
        assert!(!schedule.due(30 + CHECK_INTERVAL));
    }
    #[test]
    fn backwards_clock_does_not_postpone_checks_indefinitely() {
        let mut schedule = UpdateSchedule::new(50000, true);
        schedule.finished(50030, true);
        assert!(!schedule.due(100));
        assert!(schedule.due(130));
    }
}
