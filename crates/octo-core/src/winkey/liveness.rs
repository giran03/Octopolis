//! The self-test (WE-05) and hook liveness (WE-06), apart from Windows. A
//! probe injects a marked, unassigned key; the hook swallows it and counts it.
//! A probe that isn't seen gets the hook reinstalled and is tried again.
//!
//! "Can't test now": when the window in front can't receive injected input
//! (its process can't be opened for a limited query, or runs at a higher
//! integrity level), or Windows refuses the injected key, nothing is learned
//! about the hook. The previous status is kept, nothing is reinstalled, and the
//! next trigger tries again. Logged as `probe reason=cant_test_now`.

use std::time::Duration;

use super::log::{CANT_TEST_NOW, Stage};

/// What started a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Turning the mode on, Repair, or starting the catcher.
    SelfTest,
    Minute,
    Unlock,
    Resume,
    TaskbarCreated,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SelfTest => "self-test",
            Self::Minute => "every minute",
            Self::Unlock => "after unlock",
            Self::Resume => "after resume",
            Self::TaskbarCreated => "Explorer restarted",
        }
    }
}

/// Whether a trigger runs the probe now. The minute probe is skipped while the
/// session is locked; unlock runs it at once (WE-06).
pub fn should_probe(trigger: Trigger, locked: bool) -> bool {
    !(locked && trigger == Trigger::Minute)
}

/// What is known about the window in front, for deciding whether a probe can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Foreground {
    /// No window, or one of this process's own.
    Ours,
    /// Its process couldn't be opened for a limited query (or its token read).
    CantOpen,
    /// Opened: its integrity level and this process's.
    Integrity { theirs: u32, ours: u32 },
}

/// Why the probe can't run now, if it can't (WE-05).
pub fn cant_test_now(front: Foreground) -> Option<&'static str> {
    match front {
        Foreground::Ours => None,
        Foreground::CantOpen => Some("the app in front can't be queried"),
        Foreground::Integrity { theirs, ours } if theirs > ours => Some("the app in front runs at a higher integrity level"),
        Foreground::Integrity { .. } => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    /// No keyboard hook is installed.
    NotInstalled,
    /// The test key was sent but the hook didn't see it.
    NotSeen,
    /// The probe couldn't run (see the module notes); says nothing about the hook.
    CantTestNow(String),
}

impl ProbeError {
    pub fn reason(&self) -> String {
        match self {
            Self::NotInstalled => "the keyboard hook isn't installed".into(),
            Self::NotSeen => "the keyboard hook didn't see the test key".into(),
            Self::CantTestNow(why) => format!("can't test now: {why}"),
        }
    }
}

pub type ProbeResult = Result<Duration, ProbeError>;

/// What a check found. `health: None` keeps the last result as it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub health: Option<Result<(), String>>,
    pub reinstalled: bool,
}

/// One log line: stage, reason, optional detail, elapsed time.
pub type LogLine = (Stage, String, Option<String>, Option<u128>);

fn ms(d: Duration) -> Option<u128> {
    Some(d.as_millis())
}

/// What the caller knows going into a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Context {
    /// The hook received real (not injected) key events since the last check, so it is alive.
    pub hook_alive: bool,
    /// A reinstall is allowed now (not just after one that didn't help).
    pub may_reinstall: bool,
}

/// How long after a reinstall that didn't help before another is tried.
pub const REINSTALL_BACKOFF: Duration = Duration::from_secs(600);

/// One check: probe, and on a probe that isn't seen, reinstall and probe again.
///
/// A probe that isn't seen while the hook is receiving real keys means
/// injected input doesn't reach hooks here: "can't test now", the hook counts
/// as working, nothing is reinstalled. Without that evidence, the hook is
/// reinstalled only when `may_reinstall`, so a failed probe never loops.
pub fn check(trigger: Trigger, ctx: Context, mut probe: impl FnMut() -> ProbeResult, reinstall: impl FnOnce() -> bool, mut log: impl FnMut(LogLine)) -> Outcome {
    let why = trigger.as_str();
    let cant_test = |log: &mut dyn FnMut(LogLine), detail: &str| log((Stage::Probe, CANT_TEST_NOW.into(), Some(format!("{why}: {detail}")), None));
    let failure = match probe() {
        Ok(d) => {
            log((Stage::Probe, format!("{why}: seen"), None, ms(d)));
            return Outcome { health: Some(Ok(())), reinstalled: false };
        }
        Err(ProbeError::CantTestNow(detail)) => {
            cant_test(&mut log, &detail);
            return Outcome { health: None, reinstalled: false };
        }
        Err(e) => e,
    };
    if failure == ProbeError::NotSeen && ctx.hook_alive {
        cant_test(&mut log, "test keys don't reach the hook here, but it receives keys");
        return Outcome { health: Some(Ok(())), reinstalled: false };
    }
    log((Stage::Probe, format!("{why}: {}", failure.reason()), None, None));
    if !ctx.may_reinstall {
        log((Stage::Probe, format!("{why}: not reinstalling again yet"), None, None));
        return Outcome { health: Some(Err(failure.reason())), reinstalled: false };
    }
    let installed = reinstall();
    log((Stage::Reinstall, if installed { format!("{why}: hook reinstalled because {}", failure.reason()) } else { format!("{why}: the hook couldn't be reinstalled") }, None, None));
    let health = match probe() {
        Ok(d) => {
            log((Stage::Probe, format!("{why}: seen after reinstall"), None, ms(d)));
            Some(Ok(()))
        }
        // The hook wasn't seen before, but the retry couldn't run: still nothing new learned.
        Err(ProbeError::CantTestNow(detail)) => {
            cant_test(&mut log, &detail);
            None
        }
        Err(e) => {
            log((Stage::Probe, format!("{why}: still {} after reinstall", e.reason()), None, None));
            Some(Err(e.reason()))
        }
    };
    Outcome { health, reinstalled: true }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const FRESH: Context = Context { hook_alive: false, may_reinstall: true };

    fn run(results: Vec<ProbeResult>, reinstall_ok: bool) -> (Outcome, Vec<LogLine>, usize) {
        run_with(FRESH, results, reinstall_ok)
    }

    fn run_with(ctx: Context, results: Vec<ProbeResult>, reinstall_ok: bool) -> (Outcome, Vec<LogLine>, usize) {
        let results = RefCell::new(results.into_iter());
        let reinstalls = RefCell::new(0);
        let mut lines = Vec::new();
        let out = check(
            Trigger::Minute,
            ctx,
            || results.borrow_mut().next().expect("no more probes expected"),
            || {
                *reinstalls.borrow_mut() += 1;
                reinstall_ok
            },
            |l| lines.push(l),
        );
        let n = *reinstalls.borrow();
        (out, lines, n)
    }

    #[test]
    fn a_seen_probe_is_healthy_and_reinstalls_nothing() {
        let (out, lines, reinstalls) = run(vec![Ok(Duration::from_millis(4))], true);
        assert_eq!(out, Outcome { health: Some(Ok(())), reinstalled: false });
        assert_eq!(reinstalls, 0);
        assert_eq!(lines, vec![(Stage::Probe, "every minute: seen".to_string(), None, Some(4))]);
    }

    #[test]
    fn a_probe_not_seen_reinstalls_the_hook_and_logs_reinstall() {
        let (out, lines, reinstalls) = run(vec![Err(ProbeError::NotSeen), Ok(Duration::from_millis(3))], true);
        assert_eq!(out, Outcome { health: Some(Ok(())), reinstalled: true });
        assert_eq!(reinstalls, 1);
        assert!(lines.iter().any(|(s, r, _, _)| *s == Stage::Reinstall && r.contains("hook reinstalled")), "{lines:?}");
    }

    #[test]
    fn a_hook_that_stays_broken_reports_why() {
        let (out, _, _) = run(vec![Err(ProbeError::NotInstalled), Err(ProbeError::NotInstalled)], false);
        assert_eq!(out.health, Some(Err("the keyboard hook isn't installed".into())));
    }

    #[test]
    fn cant_test_now_keeps_the_status_reinstalls_nothing_and_logs_the_code() {
        let (out, lines, reinstalls) = run(vec![Err(ProbeError::CantTestNow("the app in front runs at a higher integrity level".into()))], true);
        assert_eq!(out, Outcome { health: None, reinstalled: false }, "the previous status is kept");
        assert_eq!(reinstalls, 0);
        assert_eq!(lines, vec![(Stage::Probe, "cant_test_now".to_string(), Some("every minute: the app in front runs at a higher integrity level".to_string()), None)]);
        assert!(lines.iter().all(|(s, ..)| *s != Stage::Reinstall), "no reinstall is logged");
    }

    #[test]
    fn an_hour_with_a_protected_app_in_front_never_reinstalls_or_fails() {
        for _ in 0..60 {
            let (out, lines, reinstalls) = run(vec![Err(ProbeError::CantTestNow("the app in front can't be queried".into()))], true);
            assert_eq!((out.health, reinstalls), (None, 0));
            assert_eq!(lines[0].1, "cant_test_now");
        }
    }

    #[test]
    fn a_failed_probe_does_not_loop() {
        // After a reinstall that didn't help, the next checks don't reinstall again.
        let ctx = Context { hook_alive: false, may_reinstall: false };
        for _ in 0..10 {
            let (out, lines, reinstalls) = run_with(ctx, vec![Err(ProbeError::NotSeen)], true);
            assert_eq!(reinstalls, 0);
            assert!(!out.reinstalled);
            assert_eq!(out.health, Some(Err("the keyboard hook didn't see the test key".into())));
            assert!(lines.iter().all(|(s, ..)| *s != Stage::Reinstall));
        }
    }

    #[test]
    fn a_hook_receiving_real_keys_is_working_even_if_test_keys_are_blocked() {
        let ctx = Context { hook_alive: true, may_reinstall: true };
        let (out, lines, reinstalls) = run_with(ctx, vec![Err(ProbeError::NotSeen)], true);
        assert_eq!(out, Outcome { health: Some(Ok(())), reinstalled: false });
        assert_eq!(reinstalls, 0, "an alive hook is never torn down");
        assert_eq!(lines[0].1, "cant_test_now");
        // A hook that isn't installed at all is still reinstalled.
        let (_, _, reinstalls) = run_with(ctx, vec![Err(ProbeError::NotInstalled), Ok(Duration::ZERO)], true);
        assert_eq!(reinstalls, 1);
    }

    #[test]
    fn the_minute_probe_is_skipped_while_locked_and_unlock_runs_at_once() {
        assert!(!should_probe(Trigger::Minute, true));
        assert!(should_probe(Trigger::Minute, false));
        assert!(should_probe(Trigger::Unlock, false));
        for t in [Trigger::SelfTest, Trigger::Resume, Trigger::TaskbarCreated] {
            assert!(should_probe(t, true), "{t:?}");
        }
    }

    #[test]
    fn the_window_in_front_decides_whether_a_probe_can_run() {
        assert_eq!(cant_test_now(Foreground::Ours), None);
        assert!(cant_test_now(Foreground::CantOpen).is_some(), "a process that can't be opened (e.g. protected)");
        assert!(cant_test_now(Foreground::Integrity { theirs: 0x3000, ours: 0x2000 }).is_some(), "elevated");
        assert_eq!(cant_test_now(Foreground::Integrity { theirs: 0x2000, ours: 0x2000 }), None);
        assert_eq!(cant_test_now(Foreground::Integrity { theirs: 0x1000, ours: 0x2000 }), None);
    }
}
