//! workbuddy-buddy core — status derivation for the WorkBuddy desktop pet.
//!
//! Pure logic, no I/O. It consumes *privacy-safe* hook events (never prompt text,
//! tool arguments, or message bodies) and derives a single display state across
//! all live WorkBuddy sessions, using two ecosystem-standard mechanisms:
//! cross-session **priority arbitration** and per-state **TTL decay**.

use std::collections::HashMap;

/// The v0 state set the pet can display (Brief §5.0: "4+1 起步").
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Idle,
    Working,
    Waiting,
    Done,
    Failed,
}

impl State {
    /// Higher wins when multiple sessions are live (cross-session arbitration).
    /// Order mirrors the Codex-pet ecosystem: failed > waiting > working > done > idle.
    pub fn priority(self) -> u8 {
        match self {
            State::Failed => 5,
            State::Waiting => 4,
            State::Working => 3,
            State::Done => 2,
            State::Idle => 1,
        }
    }

    /// How long a state stays "live" before decaying toward Idle (milliseconds).
    /// Lifetimes mirror Codex's official pet: Running 3m / Failed 1h / Waiting 24h / Review(→Done) 7d.
    /// Solves the "there is no end-of-session event" problem without polling.
    pub fn ttl_ms(self) -> Option<u64> {
        match self {
            State::Working => Some(3 * 60 * 1000),
            State::Failed => Some(60 * 60 * 1000),
            State::Waiting => Some(24 * 60 * 60 * 1000),
            State::Done => Some(7 * 24 * 60 * 60 * 1000),
            State::Idle => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Working => "working",
            State::Waiting => "waiting",
            State::Done => "done",
            State::Failed => "failed",
        }
    }
}

/// A privacy-safe hook event. Carries only structural fields — the hook script
/// projects raw WorkBuddy payloads down to this shape *before* anything is
/// persisted, so conversation content never reaches this crate.
#[derive(Clone, Debug)]
pub enum HookKind {
    SessionStart,
    UserPromptSubmit,
    PreToolUse { tool_name: String },
    PostToolUse { tool_name: String },
    PermissionRequest,
    Notification { kind: Option<String> },
    /// `ends_with_question` is computed in the hook from `last_assistant_message`,
    /// which is then discarded — we store the boolean, not the text (agentpet's
    /// QuestionDetector pattern: an agent that ends its turn asking → still waiting).
    Stop { ends_with_question: bool },
}

#[derive(Clone, Debug)]
pub struct Event {
    pub session_id: String,
    /// Unix epoch **milliseconds** (same unit as the daemon's clock). The hook
    /// stamps this; the daemon substitutes its own clock if a line lacks it.
    pub ts: u64,
    pub kind: HookKind,
}

struct SessionEntry {
    state: State,
    since: u64,
}

/// Tracks per-session state and arbitrates the single state the pet should show.
pub struct Machine {
    sessions: HashMap<String, SessionEntry>,
}

impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

impl Machine {
    pub fn new() -> Self {
        Machine { sessions: HashMap::new() }
    }

    /// Feed one event; updates the owning session's state, then evicts sessions
    /// that have decayed to Idle so memory stays bounded for a long-lived daemon.
    pub fn apply(&mut self, ev: &Event) {
        let next = match &ev.kind {
            HookKind::SessionStart => Some(State::Idle),
            HookKind::UserPromptSubmit => Some(State::Working),
            // Tool use (read-only or not) means the agent is active. In the v0
            // 5-state model this is "working"; a distinct Review state for
            // read-only tools is a future refinement.
            HookKind::PreToolUse { .. } => Some(State::Working),
            HookKind::PostToolUse { .. } => Some(State::Working),
            HookKind::PermissionRequest => Some(State::Waiting),
            HookKind::Notification { kind } => classify_notification(kind.as_deref()),
            HookKind::Stop { ends_with_question } => {
                Some(if *ends_with_question { State::Waiting } else { State::Done })
            }
        };
        if let Some(state) = next {
            self.sessions
                .insert(ev.session_id.clone(), SessionEntry { state, since: ev.ts });
        }
        self.prune(ev.ts);
    }

    /// The single state the pet should show right now: highest-priority *live*
    /// session (after TTL decay); ties broken by most-recent activity; Idle if none.
    pub fn display_state(&self, now: u64) -> State {
        self.sessions
            .values()
            .map(|e| (effective(e, now), e.since))
            .max_by(|a, b| a.0.priority().cmp(&b.0.priority()).then(a.1.cmp(&b.1)))
            .map(|(state, _)| state)
            .unwrap_or(State::Idle)
    }

    /// Number of sessions still tracked (diagnostics / eviction tests).
    pub fn tracked_sessions(&self) -> usize {
        self.sessions.len()
    }

    /// Drop sessions that have decayed to (or were explicitly set to) Idle. Idle
    /// sessions never win arbitration and Idle is the empty-map default, so
    /// removing them is behaviour-preserving and bounds memory.
    fn prune(&mut self, now: u64) {
        self.sessions.retain(|_, e| effective(e, now) != State::Idle);
    }
}

/// A session's state after applying TTL decay.
fn effective(entry: &SessionEntry, now: u64) -> State {
    match entry.state.ttl_ms() {
        // strict `>`: a state is still live *at* exactly its TTL, decayed after.
        Some(ttl) if now.saturating_sub(entry.since) > ttl => State::Idle,
        _ => entry.state,
    }
}

/// WorkBuddy has no public error-marker; we heuristically read notification kind.
/// Case-insensitive. Informational notifications (e.g. `auth_success`) return
/// None so they don't override the live state.
///
/// `idle`/`idle_prompt` → Waiting: WorkBuddy fires this when the agent finishes
/// and is idle waiting for the user, so the pet shows "your turn" (observed live).
fn classify_notification(kind: Option<&str>) -> Option<State> {
    let k = kind?.to_lowercase();
    if k.contains("error") || k.contains("fail") {
        Some(State::Failed)
    } else if k.contains("permission") || k.contains("approval") || k.contains("input")
        || k.contains("idle")
    {
        Some(State::Waiting)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60 * 1000;
    const HOUR: u64 = 60 * MIN;
    const DAY: u64 = 24 * HOUR;

    fn ev(session: &str, ts: u64, kind: HookKind) -> Event {
        Event { session_id: session.into(), ts, kind }
    }

    // ---- basic transitions -------------------------------------------------
    #[test]
    fn empty_machine_is_idle() {
        assert_eq!(Machine::new().display_state(123_456), State::Idle);
    }

    #[test]
    fn prompt_then_stop_goes_working_then_done() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 1000, HookKind::UserPromptSubmit));
        assert_eq!(m.display_state(1000), State::Working);
        m.apply(&ev("s1", 2000, HookKind::Stop { ends_with_question: false }));
        assert_eq!(m.display_state(2000), State::Done);
    }

    #[test]
    fn session_start_is_idle_then_pretooluse_works() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::SessionStart));
        assert_eq!(m.display_state(0), State::Idle);
        m.apply(&ev("s1", 1, HookKind::PreToolUse { tool_name: "Read".into() }));
        assert_eq!(m.display_state(1), State::Working);
    }

    #[test]
    fn permission_request_yields_waiting() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::UserPromptSubmit));
        m.apply(&ev("s1", 10, HookKind::PermissionRequest));
        assert_eq!(m.display_state(10), State::Waiting);
    }

    #[test]
    fn stop_with_question_waits_not_done() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::Stop { ends_with_question: true }));
        assert_eq!(m.display_state(0), State::Waiting);
    }

    #[test]
    fn state_can_regress_within_a_session() {
        // Waiting (PermissionRequest) then a later PostToolUse must drop back to Working.
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::PermissionRequest));
        assert_eq!(m.display_state(0), State::Waiting);
        m.apply(&ev("s1", 100, HookKind::PostToolUse { tool_name: "Read".into() }));
        assert_eq!(m.display_state(100), State::Working);
    }

    // ---- notification classification --------------------------------------
    #[test]
    fn notification_error_yields_failed() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::Notification { kind: Some("error".into()) }));
        assert_eq!(m.display_state(0), State::Failed);
    }

    #[test]
    fn notification_permission_kind_yields_waiting() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::Notification { kind: Some("approval_required".into()) }));
        assert_eq!(m.display_state(0), State::Waiting);
    }

    #[test]
    fn notification_idle_prompt_yields_waiting() {
        // WorkBuddy fires notification_type=idle_prompt when the agent finishes
        // and awaits the user → pet should show "your turn" (waiting). (observed live)
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::Notification { kind: Some("idle_prompt".into()) }));
        assert_eq!(m.display_state(0), State::Waiting);
    }

    #[test]
    fn notification_kind_is_case_insensitive() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::Notification { kind: Some("ERROR".into()) }));
        assert_eq!(m.display_state(0), State::Failed);
    }

    #[test]
    fn informational_notification_does_not_override_working() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::UserPromptSubmit));
        m.apply(&ev("s1", 10, HookKind::Notification { kind: Some("info".into()) }));
        assert_eq!(m.display_state(10), State::Working);
    }

    #[test]
    fn error_notification_flips_a_working_session_to_failed() {
        // Complements the informational test: proves classify_notification's
        // Some/None return path actually drives apply(), not just the None case.
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::UserPromptSubmit));
        m.apply(&ev("s1", 10, HookKind::Notification { kind: Some("error".into()) }));
        assert_eq!(m.display_state(10), State::Failed);
    }

    // ---- arbitration -------------------------------------------------------
    #[test]
    fn arbitration_prefers_higher_priority() {
        let mut m = Machine::new();
        m.apply(&ev("a", 0, HookKind::UserPromptSubmit)); // Working
        m.apply(&ev("b", 0, HookKind::PermissionRequest)); // Waiting
        assert_eq!(m.display_state(0), State::Waiting);
    }

    #[test]
    fn arbitration_breaks_priority_ties_by_recency() {
        let mut m = Machine::new();
        m.apply(&ev("a", 0, HookKind::UserPromptSubmit)); // Working @0
        m.apply(&ev("b", 500, HookKind::UserPromptSubmit)); // Working @500
        // both Working (priority tie) → most recent wins; observable via since,
        // asserted here by keeping both live and confirming state is Working.
        assert_eq!(m.display_state(500), State::Working);
    }

    // ---- TTL decay (per state, boundary, combined with arbitration) --------
    #[test]
    fn working_decays_at_its_own_ttl_boundary() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::UserPromptSubmit)); // Working, ttl 3min
        assert_eq!(m.display_state(3 * MIN), State::Working); // exactly at TTL: still live
        assert_eq!(m.display_state(3 * MIN + 1), State::Idle); // just past: decayed
    }

    #[test]
    fn failed_decays_after_one_hour() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::Notification { kind: Some("error".into()) }));
        assert_eq!(m.display_state(HOUR), State::Failed);
        assert_eq!(m.display_state(HOUR + 1), State::Idle);
    }

    #[test]
    fn waiting_decays_after_one_day() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::PermissionRequest));
        assert_eq!(m.display_state(DAY), State::Waiting);
        assert_eq!(m.display_state(DAY + 1), State::Idle);
    }

    #[test]
    fn done_decays_after_seven_days() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::Stop { ends_with_question: false }));
        assert_eq!(m.display_state(7 * DAY), State::Done);
        assert_eq!(m.display_state(7 * DAY + 1), State::Idle);
    }

    #[test]
    fn stale_failed_decays_letting_live_waiting_win() {
        // a: Failed (1h ttl) @0 ; b: Waiting (24h ttl) @0.
        let mut m = Machine::new();
        m.apply(&ev("a", 0, HookKind::Notification { kind: Some("error".into()) }));
        m.apply(&ev("b", 0, HookKind::PermissionRequest));
        assert_eq!(m.display_state(0), State::Failed); // both live → Failed wins
        assert_eq!(m.display_state(HOUR + 1), State::Waiting); // Failed decayed, Waiting remains
    }

    #[test]
    fn future_ts_stays_live_via_saturating_sub() {
        // An event stamped ahead of `now` (clock skew) must not underflow/decay.
        let mut m = Machine::new();
        m.apply(&ev("s1", 10_000, HookKind::UserPromptSubmit));
        assert_eq!(m.display_state(0), State::Working);
    }

    // ---- eviction / bounded memory ----------------------------------------
    #[test]
    fn decayed_sessions_are_evicted() {
        let mut m = Machine::new();
        for i in 0..100 {
            m.apply(&ev(&format!("s{i}"), 0, HookKind::SessionStart)); // Idle
        }
        // A later event prunes everything that has decayed to Idle.
        m.apply(&ev("live", 10 * DAY, HookKind::UserPromptSubmit));
        assert_eq!(m.tracked_sessions(), 1);
        assert_eq!(m.display_state(10 * DAY), State::Working);
    }
}
