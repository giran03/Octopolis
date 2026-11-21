//! Win+E requests and their readiness (WE-03, WE-04). Each caught Win+E gets
//! a request id. The window claims it before opening This PC and acknowledges
//! "shown" once it is visible and has painted. A request with no "shown" by
//! its deadline is cancelled: File Explorer opens instead, and a window that
//! comes up later can no longer claim it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a running, ready Octopolis has to show the window.
pub const WARM_TIMEOUT: Duration = Duration::from_secs(3);
/// How long it has while its page is still starting.
pub const COLD_TIMEOUT: Duration = Duration::from_secs(8);
/// Fallbacks in a row that count as one failed start for the failsafe.
pub const FALLBACKS_PER_FAILED_START: u32 = 2;

#[derive(Debug, Clone, Copy)]
struct Request {
    started: Instant,
    deadline: Instant,
    claimed: bool,
}

/// What became of a request whose deadline passed without "shown".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Expired {
    pub elapsed: Duration,
    /// The window took the request but didn't show it in time.
    pub claimed: bool,
    /// This fallback completes a run of [`FALLBACKS_PER_FAILED_START`]; count one failed start.
    pub failed_start: bool,
}

#[derive(Debug)]
pub struct Requests {
    next: u64,
    open: HashMap<u64, Request>,
    fallbacks_in_row: u32,
    warm: Duration,
    cold: Duration,
}

impl Default for Requests {
    fn default() -> Self {
        Self::with_timeouts(WARM_TIMEOUT, COLD_TIMEOUT)
    }
}

impl Requests {
    /// A tracker with other timeouts (tests).
    pub fn with_timeouts(warm: Duration, cold: Duration) -> Self {
        Self { next: 0, open: HashMap::new(), fallbacks_in_row: 0, warm, cold }
    }

    /// A new request. `cold`: the page hasn't reported ready yet. Returns its id and timeout.
    pub fn begin(&mut self, now: Instant, cold: bool) -> (u64, Duration) {
        // Ids start from the clock so a restarted helper doesn't reuse a recent one.
        if self.next == 0 {
            self.next = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_millis() as u64) << 8;
        }
        self.next += 1;
        let timeout = if cold { self.cold } else { self.warm };
        self.open.insert(self.next, Request { started: now, deadline: now + timeout, claimed: false });
        (self.next, timeout)
    }

    /// A request whose id comes from the helper (WE-01): tracked with that id.
    pub fn begin_with(&mut self, id: u64, now: Instant, timeout: Duration) {
        self.open.insert(id, Request { started: now, deadline: now + timeout, claimed: false });
    }

    /// Cancels `id` (the helper hung up before "shown"): it can no longer be claimed. `true` when it was open.
    pub fn cancel(&mut self, id: u64) -> bool {
        self.open.remove(&id).is_some()
    }

    /// The window asks to open request `id`. `false` for a cancelled or unknown
    /// request: it must not be opened.
    pub fn claim(&mut self, id: u64) -> bool {
        match self.open.get_mut(&id) {
            Some(r) => {
                r.claimed = true;
                true
            }
            None => false,
        }
    }

    /// The window is visible and painted for `id`. The time it took, or `None`
    /// when the request was already cancelled (or never existed).
    pub fn shown(&mut self, id: u64, now: Instant) -> Option<Duration> {
        let r = self.open.remove(&id)?;
        self.fallbacks_in_row = 0;
        Some(now.saturating_duration_since(r.started))
    }

    /// At or after the deadline: cancels `id` if it is still waiting for "shown".
    /// `None` when it was shown in time, already cancelled, or isn't due yet.
    pub fn expire(&mut self, id: u64, now: Instant) -> Option<Expired> {
        let r = *self.open.get(&id)?;
        if now < r.deadline {
            return None;
        }
        self.open.remove(&id);
        self.fallbacks_in_row += 1;
        let failed_start = self.fallbacks_in_row >= FALLBACKS_PER_FAILED_START;
        if failed_start {
            self.fallbacks_in_row = 0;
        }
        Some(Expired { elapsed: now.saturating_duration_since(r.started), claimed: r.claimed, failed_start })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_cancelled_by_its_timeout_is_not_opened_later() {
        let mut q = Requests::default();
        let t0 = Instant::now();
        let (id, timeout) = q.begin(t0, false);
        assert_eq!(timeout, WARM_TIMEOUT);
        assert_eq!(q.expire(id, t0 + Duration::from_secs(1)), None, "not due yet");
        let e = q.expire(id, t0 + timeout).expect("cancelled at the deadline");
        assert!(!e.claimed);
        assert!(!q.claim(id), "a late window can't open it");
        assert_eq!(q.shown(id, t0 + timeout * 2), None, "a late shown is ignored");
        assert_eq!(q.expire(id, t0 + timeout * 3), None, "cancelled once");
    }

    #[test]
    fn a_request_shown_in_time_never_falls_back() {
        let mut q = Requests::default();
        let t0 = Instant::now();
        let (id, _) = q.begin(t0, false);
        assert!(q.claim(id));
        assert_eq!(q.shown(id, t0 + Duration::from_millis(120)), Some(Duration::from_millis(120)));
        assert_eq!(q.expire(id, t0 + WARM_TIMEOUT), None);
    }

    #[test]
    fn a_claimed_request_still_falls_back_without_shown() {
        let mut q = Requests::default();
        let t0 = Instant::now();
        let (id, _) = q.begin(t0, false);
        assert!(q.claim(id));
        assert!(q.expire(id, t0 + WARM_TIMEOUT).unwrap().claimed);
    }

    #[test]
    fn cold_start_gets_the_longer_timeout() {
        let mut q = Requests::default();
        let t0 = Instant::now();
        let (id, timeout) = q.begin(t0, true);
        assert_eq!(timeout, COLD_TIMEOUT);
        assert_eq!(q.expire(id, t0 + WARM_TIMEOUT), None, "3 s isn't enough to give up on a cold start");
        assert!(q.expire(id, t0 + COLD_TIMEOUT).is_some());
    }

    #[test]
    fn two_fallbacks_in_a_row_count_as_one_failed_start() {
        let mut q = Requests::default();
        let t0 = Instant::now();
        let fail = |q: &mut Requests| {
            let (id, t) = q.begin(t0, false);
            q.expire(id, t0 + t).unwrap().failed_start
        };
        assert!(!fail(&mut q));
        assert!(fail(&mut q), "the second in a row counts");
        assert!(!fail(&mut q), "the run starts again");
        // A request shown in between breaks the run.
        let (id, _) = q.begin(t0, false);
        q.shown(id, t0);
        assert!(!fail(&mut q));
    }

    #[test]
    fn a_request_from_the_helper_is_tracked_by_its_id_and_can_be_cancelled() {
        let mut q = Requests::default();
        let t0 = Instant::now();
        q.begin_with(77, t0, COLD_TIMEOUT);
        assert!(q.claim(77));
        assert!(q.cancel(77), "the helper hung up");
        assert!(!q.claim(77), "a cancelled request is never opened");
        assert_eq!(q.shown(77, t0), None);
        assert!(!q.cancel(77));
    }

    #[test]
    fn ids_are_unique_and_requests_are_independent() {
        let mut q = Requests::default();
        let t0 = Instant::now();
        let (a, _) = q.begin(t0, false);
        let (b, _) = q.begin(t0, false);
        assert_ne!(a, b);
        q.expire(a, t0 + WARM_TIMEOUT);
        assert!(q.claim(b), "cancelling one doesn't touch the other");
        assert!(!q.claim(b + 999));
    }
}
