//! What the helper does with one caught Win+E (WE-03, WE-04), apart from Windows.
//!
//! A running Octopolis (the copy the entries point at) gets `OPEN(id)` and has
//! the warm timeout to answer `SHOWN(id)`. With no Octopolis serving the pipe,
//! the helper starts `Octopolis.exe ::{This PC} --win-e-request id`, waits for
//! its pipe, sends `WAIT(id)`, and has the cold timeout in all. Without
//! `SHOWN(id)` in time the connection is dropped, which cancels the request on
//! Octopolis's side, and File Explorer opens on This PC instead.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use octo_core::winkey::handoff::Requests;
use octo_core::winkey::pipe::{HungUp, Message};

/// One connection to Octopolis.
pub trait Link {
    fn send(&self, m: Message) -> bool;
    fn recv(&self, timeout: Duration) -> Result<Option<Message>, HungUp>;
}

/// What the helper needs from the system.
pub trait Env {
    type L: Link;
    /// A connection to the target copy's pipe, or `None` when it isn't served.
    fn connect(&self) -> Option<Self::L>;
    /// Starts Octopolis for request `id`.
    fn start_octopolis(&self, id: u64) -> bool;
    /// Opens File Explorer on This PC, shows the notice and logs `reason`.
    fn fall_back(&self, id: u64, reason: &str, failed_start: bool);
    /// Logs a stage line.
    fn log(&self, stage: octo_core::winkey::log::Stage, reason: &str, elapsed: Option<Duration>);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Shown { cold: bool },
    FellBack { cold: bool, failed_start: bool },
}

/// How often the helper looks for a starting Octopolis's pipe.
const POLL: Duration = Duration::from_millis(100);

fn wait_shown(link: &impl Link, id: u64, deadline: Instant) -> bool {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        match link.recv(left.min(Duration::from_millis(50))) {
            Ok(Some(Message::Shown(x))) if x == id => return true,
            Ok(_) => {}
            Err(HungUp) => return false,
        }
    }
}

/// Handles one caught Win+E.
pub fn handle(env: &impl Env, requests: &Mutex<Requests>) -> Outcome {
    let lock = || requests.lock().unwrap_or_else(|e| e.into_inner());
    let started = Instant::now();
    let first = env.connect();
    let cold = first.is_none();
    let (id, timeout) = lock().begin(started, cold);
    let deadline = started + timeout;
    let shown = match first {
        Some(link) => {
            env.log(octo_core::winkey::log::Stage::Handoff, &format!("request {id} sent to the running Octopolis"), Some(started.elapsed()));
            link.send(Message::Open(id)) && wait_shown(&link, id, deadline)
            // The link is dropped here: if it wasn't shown, Octopolis cancels the request.
        }
        None => {
            let ok = env.start_octopolis(id);
            env.log(octo_core::winkey::log::Stage::Handoff, &format!("request {id}: {}", if ok { "no Octopolis answered, so it was started" } else { "Octopolis couldn't be started" }), Some(started.elapsed()));
            let mut shown = false;
            while ok && Instant::now() < deadline {
                if let Some(link) = env.connect() {
                    shown = link.send(Message::Wait(id)) && wait_shown(&link, id, deadline);
                    break;
                }
                std::thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
            }
            shown
        }
    };
    if shown {
        let elapsed = lock().shown(id, Instant::now());
        env.log(octo_core::winkey::log::Stage::Shown, &format!("request {id}"), elapsed);
        return Outcome::Shown { cold };
    }
    let expired = lock().expire(id, deadline);
    let failed_start = expired.is_some_and(|e| e.failed_start);
    let reason = format!("request {id}: Octopolis didn't show the window within {} s", timeout.as_secs_f32());
    env.log(octo_core::winkey::log::Stage::Cancel, &reason, Some(started.elapsed()));
    env.fall_back(id, &reason, failed_start);
    Outcome::FellBack { cold, failed_start }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    const WARM: Duration = Duration::from_millis(150);
    const COLD: Duration = Duration::from_millis(400);

    /// A fake Octopolis: `answers` says whether it shows the window.
    struct FakeLink {
        answers: bool,
        last: Cell<Option<u64>>,
    }

    impl Link for FakeLink {
        fn send(&self, m: Message) -> bool {
            if let Message::Open(id) | Message::Wait(id) = m {
                self.last.set(Some(id));
            }
            true
        }
        fn recv(&self, timeout: Duration) -> Result<Option<Message>, HungUp> {
            match (self.answers, self.last.get()) {
                (true, Some(id)) => Ok(Some(Message::Shown(id))),
                _ => {
                    std::thread::sleep(timeout);
                    Ok(None)
                }
            }
        }
    }

    #[derive(Default)]
    struct FakeEnv {
        /// Whether an Octopolis serves the pipe, now and after it is started.
        serving: Cell<bool>,
        starts_serving: bool,
        answers: bool,
        started: RefCell<Vec<u64>>,
        fallbacks: RefCell<Vec<(u64, bool)>>,
    }

    impl Env for FakeEnv {
        type L = FakeLink;
        fn connect(&self) -> Option<FakeLink> {
            if !self.serving.get() {
                return None;
            }
            Some(FakeLink { answers: self.answers, last: Cell::new(None) })
        }
        fn start_octopolis(&self, id: u64) -> bool {
            self.started.borrow_mut().push(id);
            if self.starts_serving {
                self.serving.set(true);
            }
            true
        }
        fn fall_back(&self, id: u64, _: &str, failed_start: bool) {
            self.fallbacks.borrow_mut().push((id, failed_start));
        }
        fn log(&self, _: octo_core::winkey::log::Stage, _: &str, _: Option<Duration>) {}
    }

    fn requests() -> Mutex<Requests> {
        Mutex::new(Requests::with_timeouts(WARM, COLD))
    }

    #[test]
    fn a_running_octopolis_that_shows_the_window_gets_no_fallback() {
        let env = FakeEnv { answers: true, ..FakeEnv::default() };
        env.serving.set(true);
        assert_eq!(handle(&env, &requests()), Outcome::Shown { cold: false });
        assert!(env.fallbacks.borrow().is_empty());
        assert!(env.started.borrow().is_empty(), "no second Octopolis is started");
    }

    #[test]
    fn a_running_octopolis_that_doesnt_answer_falls_back_after_the_warm_timeout() {
        let env = FakeEnv { answers: false, ..FakeEnv::default() };
        env.serving.set(true);
        let started = Instant::now();
        assert_eq!(handle(&env, &requests()), Outcome::FellBack { cold: false, failed_start: false });
        assert!(started.elapsed() >= WARM && started.elapsed() < COLD, "{:?}", started.elapsed());
        assert_eq!(env.fallbacks.borrow().len(), 1, "exactly one fallback");
    }

    #[test]
    fn with_no_octopolis_running_it_is_started_for_the_request() {
        let env = FakeEnv { starts_serving: true, answers: true, ..FakeEnv::default() };
        assert_eq!(handle(&env, &requests()), Outcome::Shown { cold: true });
        assert_eq!(env.started.borrow().len(), 1);
        assert!(env.fallbacks.borrow().is_empty());
    }

    #[test]
    fn an_octopolis_that_never_comes_up_falls_back_after_the_cold_timeout() {
        let env = FakeEnv { starts_serving: false, ..FakeEnv::default() };
        let started = Instant::now();
        assert_eq!(handle(&env, &requests()), Outcome::FellBack { cold: true, failed_start: false });
        assert!(started.elapsed() >= COLD, "{:?}", started.elapsed());
        assert_eq!(env.started.borrow().len(), 1, "started once");
        assert_eq!(env.fallbacks.borrow().len(), 1);
    }

    #[test]
    fn two_fallbacks_in_a_row_count_as_one_failed_start() {
        let env = FakeEnv { answers: false, ..FakeEnv::default() };
        env.serving.set(true);
        let q = requests();
        assert_eq!(handle(&env, &q), Outcome::FellBack { cold: false, failed_start: false });
        assert_eq!(handle(&env, &q), Outcome::FellBack { cold: false, failed_start: true });
    }
}
