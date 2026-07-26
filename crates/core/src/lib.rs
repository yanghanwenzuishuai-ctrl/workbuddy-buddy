//! workbuddy-buddy core — status derivation for the WorkBuddy desktop pet.
//!
//! Pure logic, no I/O. It consumes *privacy-safe* hook events (never prompt text,
//! tool arguments, or message bodies) and derives a semantic status snapshot
//! across all live WorkBuddy sessions. Display arbitration, activity eligibility,
//! and inactivity-derived visuals are intentionally separate so UI changes cannot
//! silently change future leaderboard accounting.

use std::collections::HashMap;

/// Legacy pet state used by the existing bridge and Tauri consumers.
///
/// New code should prefer [`StatusSnapshot`]. The four `Slacking*` variants are
/// a compatibility overlay of `display_state + idle_stage`, not activity states.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Idle,
    Working,
    Waiting,
    Done,
    Failed,
    SlackingFresh,
    SlackingSalted,
    SlackingCostume,
    SlackingFish,
}

impl State {
    /// Legacy priority retained for downstream compatibility. Core arbitration
    /// uses [`DisplayState::priority`] and never mixes in `idle_stage`.
    pub fn priority(self) -> u8 {
        match self {
            State::Failed => 6,
            State::Waiting => 5,
            State::Working => 4,
            State::SlackingFresh
            | State::SlackingSalted
            | State::SlackingCostume
            | State::SlackingFish => 3,
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
            State::Idle
            | State::SlackingFresh
            | State::SlackingSalted
            | State::SlackingCostume
            | State::SlackingFish => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Working => "working",
            State::Waiting => "waiting",
            State::Done => "done",
            State::Failed => "failed",
            State::SlackingFresh => "slacking",
            State::SlackingSalted => "slacking_salted",
            State::SlackingCostume => "slacking_costume",
            State::SlackingFish => "slacking_shared_fish",
        }
    }
}

/// The base action the pet should perform, independent of inactivity visuals.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DisplayState {
    Idle,
    Working,
    Waiting,
    Done,
    Failed,
}

impl DisplayState {
    fn priority(self) -> u8 {
        match self {
            DisplayState::Failed => 5,
            DisplayState::Waiting => 4,
            DisplayState::Working => 3,
            DisplayState::Done => 2,
            DisplayState::Idle => 1,
        }
    }

    fn ttl_ms(self) -> Option<u64> {
        match self {
            DisplayState::Working => Some(3 * 60 * 1000),
            DisplayState::Failed => Some(60 * 60 * 1000),
            DisplayState::Waiting => Some(24 * 60 * 60 * 1000),
            DisplayState::Done => Some(7 * 24 * 60 * 60 * 1000),
            DisplayState::Idle => None,
        }
    }

    fn legacy(self) -> State {
        match self {
            DisplayState::Idle => State::Idle,
            DisplayState::Working => State::Working,
            DisplayState::Waiting => State::Waiting,
            DisplayState::Done => State::Done,
            DisplayState::Failed => State::Failed,
        }
    }
}

/// Whether the current WorkBuddy condition is eligible for idle accounting.
///
/// `Unknown` means no WorkBuddy signal has been accepted yet and must never open
/// an eligible interval downstream.
///
/// `Waiting` means approval/user-input waiting and is deliberately distinct
/// from `EligibleIdle`; an `idle_prompt` is displayed as Waiting but classified
/// as `EligibleIdle`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActivityState {
    Unknown,
    Active,
    EligibleIdle,
    Waiting,
    Failed,
}

impl ActivityState {
    fn priority(self) -> u8 {
        match self {
            ActivityState::Failed => 3,
            ActivityState::Waiting => 2,
            ActivityState::Active => 1,
            ActivityState::EligibleIdle | ActivityState::Unknown => 0,
        }
    }
}

/// Inactivity-derived visual stage. It never participates in base display
/// arbitration and never resets `activity_since`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IdleStage {
    None,
    Fresh,
    Salted,
    Costume,
    Fish,
}

/// Semantic status for future Edge reporting and server-side accounting.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StatusSnapshot {
    pub display_state: DisplayState,
    pub activity_state: ActivityState,
    pub idle_stage: IdleStage,
    pub display_since: Option<u64>,
    pub activity_since: Option<u64>,
}

impl StatusSnapshot {
    /// Convert to the existing one-string pet protocol without changing current
    /// bridge/Tauri consumers.
    pub fn legacy_state(self) -> State {
        match self.idle_stage {
            IdleStage::Fresh => State::SlackingFresh,
            IdleStage::Salted => State::SlackingSalted,
            IdleStage::Costume => State::SlackingCostume,
            IdleStage::Fish => State::SlackingFish,
            IdleStage::None => self.display_state.legacy(),
        }
    }
}

const SLACKING_FRESH_MS: u64 = 15 * 60 * 1000;
const SLACKING_SALTED_MS: u64 = 25 * 60 * 1000;
const SLACKING_COSTUME_MS: u64 = 35 * 60 * 1000;
const SLACKING_FISH_MS: u64 = 60 * 60 * 1000;

/// A privacy-safe hook event. Carries only structural fields — the hook script
/// projects raw WorkBuddy payloads down to this shape *before* anything is
/// persisted, so conversation content never reaches this crate.
#[derive(Clone, Debug)]
pub enum HookKind {
    SessionStart,
    UserPromptSubmit,
    PreToolUse {
        tool_name: String,
    },
    PostToolUse {
        tool_name: String,
    },
    PermissionRequest,
    Notification {
        kind: Option<String>,
    },
    /// `ends_with_question` is computed in the hook from `last_assistant_message`,
    /// which is then discarded — we store the boolean, not the text (agentpet's
    /// QuestionDetector pattern: an agent that ends its turn asking → still waiting).
    Stop {
        ends_with_question: bool,
    },
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
    display_state: DisplayState,
    activity_state: ActivityState,
    display_since: u64,
    activity_since: u64,
}

#[derive(Clone, Copy)]
struct EffectiveEntry {
    display_state: DisplayState,
    activity_state: ActivityState,
    display_since: u64,
    activity_since: u64,
}

/// Tracks per-session state and derives a semantic aggregate snapshot.
pub struct Machine {
    sessions: HashMap<String, SessionEntry>,
    /// Start of the current aggregate interval in which every live session has
    /// remained eligible. Adding another already-idle session preserves this
    /// boundary; only a meaningful/blocked transition clears it.
    eligible_since: Option<u64>,
    /// Most recent transition into an evicted base Idle display.
    idle_display_since: Option<u64>,
    /// Monotonic local processing boundary. It prevents an older spool timestamp
    /// from running TTL pruning backwards.
    last_timeline_at: Option<u64>,
}

impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

impl Machine {
    pub fn new() -> Self {
        Machine {
            sessions: HashMap::new(),
            eligible_since: None,
            idle_display_since: None,
            last_timeline_at: None,
        }
    }

    /// Compatibility helper for trusted, already ordered local events. It treats
    /// `ev.ts` as both source time and accepted timeline time.
    pub fn apply(&mut self, ev: &Event) {
        self.apply_at(ev, ev.ts);
    }

    /// Feed an event at an explicit local/server receive time.
    ///
    /// `received_at` is the authoritative timeline for TTL and activity
    /// boundaries. `ev.ts` is an observed wall clock and is deliberately not used
    /// as a replay/ordering sequence; that gate belongs to the future Edge
    /// `boot_id + sequence` protocol. Informational notifications intentionally
    /// produce no semantic transition and cannot reset eligible idle.
    pub fn apply_at(&mut self, ev: &Event, received_at: u64) {
        let timeline_at = self
            .last_timeline_at
            .map_or(received_at, |last| last.max(received_at));
        self.advance(timeline_at);
        self.last_timeline_at = Some(timeline_at);

        let next = match &ev.kind {
            HookKind::SessionStart => Some((DisplayState::Idle, ActivityState::EligibleIdle)),
            HookKind::UserPromptSubmit => Some((DisplayState::Working, ActivityState::Active)),
            // Tool use (read-only or not) means the agent is active. In the v0
            // 5-state model this is "working"; a distinct Review state for
            // read-only tools is a future refinement.
            HookKind::PreToolUse { .. } => Some((DisplayState::Working, ActivityState::Active)),
            HookKind::PostToolUse { .. } => Some((DisplayState::Working, ActivityState::Active)),
            HookKind::PermissionRequest => Some((DisplayState::Waiting, ActivityState::Waiting)),
            HookKind::Notification { kind } => classify_notification(kind.as_deref()),
            HookKind::Stop { ends_with_question } => Some(if *ends_with_question {
                (DisplayState::Waiting, ActivityState::Waiting)
            } else {
                (DisplayState::Done, ActivityState::EligibleIdle)
            }),
        };

        if let Some((display_state, activity_state)) = next {
            if activity_state != ActivityState::EligibleIdle {
                // Any meaningful activity or blocked state ends the aggregate
                // continuous eligible-idle interval. Other eligible sessions are
                // still tracked and will establish a new boundary once every
                // blocker clears.
                self.eligible_since = None;
            }
            self.sessions.insert(
                ev.session_id.clone(),
                SessionEntry {
                    display_state,
                    activity_state,
                    display_since: timeline_at,
                    activity_since: timeline_at,
                },
            );

            if activity_state == ActivityState::EligibleIdle
                && self.eligible_since.is_none()
                && self
                    .sessions
                    .values()
                    .all(|entry| entry.activity_state == ActivityState::EligibleIdle)
            {
                // false -> true. If the machine was already eligible, the
                // existing anchor is deliberately preserved above.
                self.eligible_since = Some(timeline_at);
            }
        }
        self.prune_idle();
    }

    /// Derive the base display, accounting activity, and independent idle visual
    /// stage at `now`.
    pub fn snapshot(&self, now: u64) -> StatusSnapshot {
        let current_entries: Vec<_> = self
            .sessions
            .values()
            .map(|entry| effective(entry, now))
            .collect();

        let display = current_entries
            .iter()
            .map(|entry| (entry.display_state, entry.display_since))
            .chain(
                self.idle_display_since
                    .map(|since| (DisplayState::Idle, since)),
            )
            .max_by(|a, b| a.0.priority().cmp(&b.0.priority()).then(a.1.cmp(&b.1)));

        let blocker = current_entries
            .iter()
            .filter(|entry| entry.activity_state != ActivityState::EligibleIdle)
            .max_by(|a, b| {
                a.activity_state
                    .priority()
                    .cmp(&b.activity_state.priority())
                    .then(a.activity_since.cmp(&b.activity_since))
            });

        let (activity_state, activity_since) = if let Some(entry) = blocker {
            (entry.activity_state, Some(entry.activity_since))
        } else {
            let newly_eligible_since = self
                .sessions
                .values()
                .filter_map(|stored| {
                    let current = effective(stored, now);
                    (stored.activity_state != ActivityState::EligibleIdle
                        && current.activity_state == ActivityState::EligibleIdle)
                        .then_some(current.activity_since)
                })
                .max();
            let since = self.eligible_since.or(newly_eligible_since);
            (
                if since.is_some() {
                    ActivityState::EligibleIdle
                } else {
                    ActivityState::Unknown
                },
                since,
            )
        };

        let idle_stage = if activity_state == ActivityState::EligibleIdle {
            activity_since
                .map(|since| idle_stage(now.saturating_sub(since)))
                .unwrap_or(IdleStage::None)
        } else {
            IdleStage::None
        };

        StatusSnapshot {
            display_state: display.map(|value| value.0).unwrap_or(DisplayState::Idle),
            display_since: display.map(|value| value.1),
            activity_state,
            activity_since,
            idle_stage,
        }
    }

    /// Compatibility projection for the existing one-string pet protocol.
    pub fn display_state(&self, now: u64) -> State {
        self.snapshot(now).legacy_state()
    }

    /// Number of sessions still tracked (diagnostics / eviction tests).
    pub fn tracked_sessions(&self) -> usize {
        self.sessions.len()
    }

    /// Materialize deterministic TTL transitions up to `now`. If the last live
    /// blocker expires, the new aggregate interval begins at that blocker's
    /// exact TTL boundary, not at the time this method happened to be called.
    fn advance(&mut self, now: u64) {
        let mut newly_eligible_since = None;
        for entry in self.sessions.values_mut() {
            let previous_activity = entry.activity_state;
            let current = effective(entry, now);
            if previous_activity != ActivityState::EligibleIdle
                && current.activity_state == ActivityState::EligibleIdle
            {
                newly_eligible_since = Some(
                    newly_eligible_since.map_or(current.activity_since, |since: u64| {
                        since.max(current.activity_since)
                    }),
                );
            }
            entry.display_state = current.display_state;
            entry.activity_state = current.activity_state;
            entry.display_since = current.display_since;
            entry.activity_since = current.activity_since;
        }

        if self
            .sessions
            .values()
            .any(|entry| entry.activity_state != ActivityState::EligibleIdle)
        {
            self.eligible_since = None;
        } else if self.eligible_since.is_none() && !self.sessions.is_empty() {
            self.eligible_since = newly_eligible_since;
        }

        self.prune_idle();
    }

    /// Drop sessions whose base display has reached Idle, retaining the aggregate
    /// boundaries needed for semantic snapshots.
    fn prune_idle(&mut self) {
        let mut idle_display = self.idle_display_since;
        self.sessions.retain(|_, entry| {
            if entry.display_state != DisplayState::Idle {
                return true;
            }
            idle_display = Some(
                idle_display.map_or(entry.display_since, |since| since.max(entry.display_since)),
            );
            false
        });
        self.idle_display_since = idle_display;
    }
}

/// A session's state after applying display TTL decay. A previously blocked or
/// active session opens a fresh eligible interval only after its TTL expires;
/// eligible Done/idle-prompt time remains continuous across visual decay.
fn effective(entry: &SessionEntry, now: u64) -> EffectiveEntry {
    match entry.display_state.ttl_ms() {
        // strict `>`: a state is still live *at* exactly its TTL, decayed after.
        Some(ttl) if now.saturating_sub(entry.display_since) > ttl => {
            let decay_at = entry.display_since.saturating_add(ttl).saturating_add(1);
            EffectiveEntry {
                display_state: DisplayState::Idle,
                display_since: decay_at,
                activity_state: ActivityState::EligibleIdle,
                activity_since: if entry.activity_state == ActivityState::EligibleIdle {
                    entry.activity_since
                } else {
                    decay_at
                },
            }
        }
        _ => EffectiveEntry {
            display_state: entry.display_state,
            activity_state: entry.activity_state,
            display_since: entry.display_since,
            activity_since: entry.activity_since,
        },
    }
}

fn idle_stage(inactive_ms: u64) -> IdleStage {
    if inactive_ms >= SLACKING_FISH_MS {
        IdleStage::Fish
    } else if inactive_ms >= SLACKING_COSTUME_MS {
        IdleStage::Costume
    } else if inactive_ms >= SLACKING_SALTED_MS {
        IdleStage::Salted
    } else if inactive_ms >= SLACKING_FRESH_MS {
        IdleStage::Fresh
    } else {
        IdleStage::None
    }
}

/// WorkBuddy has no public error-marker; we heuristically read notification kind.
/// Case-insensitive. Informational notifications (e.g. `auth_success`) return
/// None so they don't override the live state.
///
/// `idle`/`idle_prompt` is the intentional split case: the pet visually shows
/// "your turn" while the interval is eligible for idle accounting.
fn classify_notification(kind: Option<&str>) -> Option<(DisplayState, ActivityState)> {
    let k = kind?.to_lowercase();
    if k.contains("error") || k.contains("fail") {
        Some((DisplayState::Failed, ActivityState::Failed))
    } else if k.contains("permission") || k.contains("approval") || k.contains("input") {
        Some((DisplayState::Waiting, ActivityState::Waiting))
    } else if k.contains("idle") {
        Some((DisplayState::Waiting, ActivityState::EligibleIdle))
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
        Event {
            session_id: session.into(),
            ts,
            kind,
        }
    }

    // ---- basic transitions -------------------------------------------------
    #[test]
    fn empty_machine_is_idle() {
        let snapshot = Machine::new().snapshot(123_456);
        assert_eq!(snapshot.display_state, DisplayState::Idle);
        assert_eq!(snapshot.activity_state, ActivityState::Unknown);
        assert_eq!(snapshot.idle_stage, IdleStage::None);
        assert_eq!(snapshot.display_since, None);
        assert_eq!(snapshot.activity_since, None);
        assert_eq!(snapshot.legacy_state(), State::Idle);
    }

    #[test]
    fn prompt_then_stop_goes_working_then_done() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 1000, HookKind::UserPromptSubmit));
        assert_eq!(m.display_state(1000), State::Working);
        m.apply(&ev(
            "s1",
            2000,
            HookKind::Stop {
                ends_with_question: false,
            },
        ));
        assert_eq!(m.display_state(2000), State::Done);
    }

    #[test]
    fn session_start_is_idle_then_pretooluse_works() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::SessionStart));
        assert_eq!(m.display_state(0), State::Idle);
        m.apply(&ev(
            "s1",
            1,
            HookKind::PreToolUse {
                tool_name: "Read".into(),
            },
        ));
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
        m.apply(&ev(
            "s1",
            0,
            HookKind::Stop {
                ends_with_question: true,
            },
        ));
        assert_eq!(m.display_state(0), State::Waiting);
    }

    #[test]
    fn state_can_regress_within_a_session() {
        // Waiting (PermissionRequest) then a later PostToolUse must drop back to Working.
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::PermissionRequest));
        assert_eq!(m.display_state(0), State::Waiting);
        m.apply(&ev(
            "s1",
            100,
            HookKind::PostToolUse {
                tool_name: "Read".into(),
            },
        ));
        assert_eq!(m.display_state(100), State::Working);
    }

    // ---- notification classification --------------------------------------
    #[test]
    fn notification_error_yields_failed() {
        let mut m = Machine::new();
        m.apply(&ev(
            "s1",
            0,
            HookKind::Notification {
                kind: Some("error".into()),
            },
        ));
        assert_eq!(m.display_state(0), State::Failed);
    }

    #[test]
    fn notification_permission_kind_yields_waiting() {
        let mut m = Machine::new();
        m.apply(&ev(
            "s1",
            0,
            HookKind::Notification {
                kind: Some("approval_required".into()),
            },
        ));
        assert_eq!(m.display_state(0), State::Waiting);
    }

    #[test]
    fn notification_idle_prompt_yields_waiting() {
        // WorkBuddy fires notification_type=idle_prompt when the agent finishes
        // and awaits the user → pet should show "your turn" (waiting). (observed live)
        let mut m = Machine::new();
        m.apply(&ev(
            "s1",
            0,
            HookKind::Notification {
                kind: Some("idle_prompt".into()),
            },
        ));
        let snapshot = m.snapshot(0);
        assert_eq!(snapshot.display_state, DisplayState::Waiting);
        assert_eq!(snapshot.activity_state, ActivityState::EligibleIdle);
        assert_eq!(snapshot.activity_since, Some(0));
        assert_eq!(snapshot.legacy_state(), State::Waiting);
    }

    #[test]
    fn notification_kind_is_case_insensitive() {
        let mut m = Machine::new();
        m.apply(&ev(
            "s1",
            0,
            HookKind::Notification {
                kind: Some("ERROR".into()),
            },
        ));
        assert_eq!(m.display_state(0), State::Failed);
    }

    #[test]
    fn informational_notification_does_not_override_working() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::UserPromptSubmit));
        m.apply(&ev(
            "s1",
            10,
            HookKind::Notification {
                kind: Some("info".into()),
            },
        ));
        let snapshot = m.snapshot(10);
        assert_eq!(snapshot.display_state, DisplayState::Working);
        assert_eq!(snapshot.activity_state, ActivityState::Active);
        assert_eq!(snapshot.activity_since, Some(0));
    }

    #[test]
    fn error_notification_flips_a_working_session_to_failed() {
        // Complements the informational test: proves classify_notification's
        // Some/None return path actually drives apply(), not just the None case.
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::UserPromptSubmit));
        m.apply(&ev(
            "s1",
            10,
            HookKind::Notification {
                kind: Some("error".into()),
            },
        ));
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

    #[test]
    fn legacy_slacking_priority_remains_compatible() {
        for active in [State::Failed, State::Waiting, State::Working] {
            assert!(active.priority() > State::SlackingFresh.priority());
        }
        for slacking in [
            State::SlackingFresh,
            State::SlackingSalted,
            State::SlackingCostume,
            State::SlackingFish,
        ] {
            assert_eq!(slacking.priority(), State::SlackingFresh.priority());
            assert!(slacking.priority() > State::Done.priority());
            assert!(slacking.priority() > State::Idle.priority());
        }
    }

    // ---- inactivity / slacking progression -------------------------------
    #[test]
    fn idle_slacking_stages_change_at_inclusive_boundaries() {
        let mut m = Machine::new();
        let start = 1234;
        m.apply(&ev("s1", start, HookKind::SessionStart));

        assert_eq!(m.display_state(start + SLACKING_FRESH_MS - 1), State::Idle);
        assert_eq!(
            m.display_state(start + SLACKING_FRESH_MS),
            State::SlackingFresh
        );
        assert_eq!(
            m.display_state(start + SLACKING_SALTED_MS - 1),
            State::SlackingFresh
        );
        assert_eq!(
            m.display_state(start + SLACKING_SALTED_MS),
            State::SlackingSalted
        );
        assert_eq!(
            m.display_state(start + SLACKING_COSTUME_MS - 1),
            State::SlackingSalted
        );
        assert_eq!(
            m.display_state(start + SLACKING_COSTUME_MS),
            State::SlackingCostume
        );
        assert_eq!(
            m.display_state(start + SLACKING_FISH_MS - 1),
            State::SlackingCostume
        );
        assert_eq!(
            m.display_state(start + SLACKING_FISH_MS),
            State::SlackingFish
        );
        for (elapsed, stage) in [
            (SLACKING_FRESH_MS, IdleStage::Fresh),
            (SLACKING_SALTED_MS, IdleStage::Salted),
            (SLACKING_COSTUME_MS, IdleStage::Costume),
            (SLACKING_FISH_MS, IdleStage::Fish),
        ] {
            let snapshot = m.snapshot(start + elapsed);
            assert_eq!(snapshot.idle_stage, stage);
            assert_eq!(snapshot.activity_since, Some(start));
        }
    }

    #[test]
    fn done_keeps_its_base_display_when_idle_stage_advances() {
        let mut m = Machine::new();
        m.apply(&ev(
            "s1",
            0,
            HookKind::Stop {
                ends_with_question: false,
            },
        ));
        assert_eq!(m.display_state(SLACKING_FRESH_MS - 1), State::Done);
        assert_eq!(m.display_state(SLACKING_FRESH_MS), State::SlackingFresh);
        let snapshot = m.snapshot(SLACKING_FRESH_MS);
        assert_eq!(snapshot.display_state, DisplayState::Done);
        assert_eq!(snapshot.activity_state, ActivityState::EligibleIdle);
        assert_eq!(snapshot.idle_stage, IdleStage::Fresh);
        assert_eq!(snapshot.activity_since, Some(0));
    }

    #[test]
    fn empty_machine_has_no_inactivity_clock() {
        assert_eq!(Machine::new().display_state(SLACKING_FISH_MS), State::Idle);
    }

    #[test]
    fn informational_notification_preserves_eligible_idle_boundary() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::SessionStart));
        assert_eq!(m.display_state(SLACKING_FISH_MS), State::SlackingFish);

        // Informational notifications are transport/UI noise, not meaningful
        // activity, so the original continuous-idle boundary is retained.
        m.apply(&ev(
            "s1",
            SLACKING_FISH_MS,
            HookKind::Notification {
                kind: Some("info".into()),
            },
        ));
        let snapshot = m.snapshot(SLACKING_FISH_MS);
        assert_eq!(snapshot.idle_stage, IdleStage::Fish);
        assert_eq!(snapshot.activity_since, Some(0));
        assert_eq!(snapshot.legacy_state(), State::SlackingFish);
    }

    #[test]
    fn out_of_order_events_do_not_rewind_last_activity() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 2000, HookKind::SessionStart));
        m.apply(&ev(
            "s1",
            1000,
            HookKind::Notification {
                kind: Some("info".into()),
            },
        ));

        assert_eq!(m.display_state(2000 + SLACKING_FRESH_MS - 1), State::Idle);
        assert_eq!(
            m.display_state(2000 + SLACKING_FRESH_MS),
            State::SlackingFresh
        );
    }

    #[test]
    fn future_activity_timestamp_does_not_underflow_idle_clock() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 10_000, HookKind::SessionStart));
        assert_eq!(m.display_state(0), State::Idle);
        assert_eq!(
            m.display_state(10_000 + SLACKING_FRESH_MS),
            State::SlackingFresh
        );
    }

    #[test]
    fn waiting_and_failed_are_not_overridden_by_slacking() {
        let mut waiting = Machine::new();
        waiting.apply(&ev("s1", 0, HookKind::PermissionRequest));
        assert_eq!(waiting.display_state(SLACKING_FISH_MS), State::Waiting);

        let mut failed = Machine::new();
        failed.apply(&ev(
            "s1",
            0,
            HookKind::Notification {
                kind: Some("error".into()),
            },
        ));
        assert_eq!(failed.display_state(SLACKING_FISH_MS), State::Failed);
        // Failed is live at its exact TTL. Its expiry opens a new eligible
        // interval; failed time is never back-counted.
        let after_decay = failed.snapshot(SLACKING_FISH_MS + 1);
        assert_eq!(after_decay.display_state, DisplayState::Idle);
        assert_eq!(after_decay.activity_state, ActivityState::EligibleIdle);
        assert_eq!(after_decay.activity_since, Some(SLACKING_FISH_MS + 1));
        assert_eq!(after_decay.idle_stage, IdleStage::None);
    }

    // ---- TTL decay (per state, boundary, combined with arbitration) --------
    #[test]
    fn working_decays_at_its_own_ttl_boundary() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::UserPromptSubmit)); // Working, ttl 3min
        assert_eq!(m.display_state(3 * MIN), State::Working); // exactly at TTL: still live
        assert_eq!(m.display_state(3 * MIN + 1), State::Idle); // just past: decayed
        let after_decay = m.snapshot(3 * MIN + 1);
        assert_eq!(after_decay.activity_state, ActivityState::EligibleIdle);
        assert_eq!(after_decay.activity_since, Some(3 * MIN + 1));
        assert_eq!(after_decay.idle_stage, IdleStage::None);
        assert_eq!(
            m.snapshot(3 * MIN + 1 + SLACKING_FRESH_MS).idle_stage,
            IdleStage::Fresh
        );
    }

    #[test]
    fn failed_ttl_opens_a_new_eligible_interval_without_backdating() {
        let mut m = Machine::new();
        m.apply(&ev(
            "s1",
            0,
            HookKind::Notification {
                kind: Some("error".into()),
            },
        ));
        assert_eq!(m.display_state(HOUR), State::Failed);
        assert_eq!(m.display_state(HOUR + 1), State::Idle);
        assert_eq!(m.snapshot(HOUR + 1).activity_since, Some(HOUR + 1));
        assert_eq!(
            m.display_state(HOUR + 1 + SLACKING_FRESH_MS),
            State::SlackingFresh
        );
    }

    #[test]
    fn waiting_ttl_opens_a_new_eligible_interval_without_backdating() {
        let mut m = Machine::new();
        m.apply(&ev("s1", 0, HookKind::PermissionRequest));
        assert_eq!(m.display_state(DAY), State::Waiting);
        assert_eq!(m.display_state(DAY + 1), State::Idle);
        assert_eq!(m.snapshot(DAY + 1).activity_since, Some(DAY + 1));
        assert_eq!(
            m.display_state(DAY + 1 + SLACKING_FRESH_MS),
            State::SlackingFresh
        );
    }

    #[test]
    fn done_still_decays_after_seven_days_under_the_display_overlay() {
        let entry = SessionEntry {
            display_state: DisplayState::Done,
            activity_state: ActivityState::EligibleIdle,
            display_since: 0,
            activity_since: 0,
        };
        let at_ttl = effective(&entry, 7 * DAY);
        assert_eq!(at_ttl.display_state, DisplayState::Done);
        assert_eq!(at_ttl.activity_since, 0);
        let after_ttl = effective(&entry, 7 * DAY + 1);
        assert_eq!(after_ttl.display_state, DisplayState::Idle);
        assert_eq!(after_ttl.activity_since, 0);
    }

    #[test]
    fn stale_failed_decays_letting_live_waiting_win() {
        // a: Failed (1h ttl) @0 ; b: Waiting (24h ttl) @0.
        let mut m = Machine::new();
        m.apply(&ev(
            "a",
            0,
            HookKind::Notification {
                kind: Some("error".into()),
            },
        ));
        m.apply(&ev("b", 0, HookKind::PermissionRequest));
        assert_eq!(m.display_state(0), State::Failed); // both live → Failed wins
        assert_eq!(m.display_state(HOUR + 1), State::Waiting); // Failed decayed, Waiting remains
    }

    #[test]
    fn hook_kinds_map_to_split_display_and_activity_semantics() {
        let cases = [
            (
                HookKind::SessionStart,
                DisplayState::Idle,
                ActivityState::EligibleIdle,
            ),
            (
                HookKind::UserPromptSubmit,
                DisplayState::Working,
                ActivityState::Active,
            ),
            (
                HookKind::PreToolUse {
                    tool_name: "Read".into(),
                },
                DisplayState::Working,
                ActivityState::Active,
            ),
            (
                HookKind::PermissionRequest,
                DisplayState::Waiting,
                ActivityState::Waiting,
            ),
            (
                HookKind::Stop {
                    ends_with_question: true,
                },
                DisplayState::Waiting,
                ActivityState::Waiting,
            ),
            (
                HookKind::Stop {
                    ends_with_question: false,
                },
                DisplayState::Done,
                ActivityState::EligibleIdle,
            ),
            (
                HookKind::Notification {
                    kind: Some("error".into()),
                },
                DisplayState::Failed,
                ActivityState::Failed,
            ),
            (
                HookKind::Notification {
                    kind: Some("idle_prompt".into()),
                },
                DisplayState::Waiting,
                ActivityState::EligibleIdle,
            ),
        ];

        for (kind, display_state, activity_state) in cases {
            let mut m = Machine::new();
            m.apply(&ev("s", 50, kind));
            let snapshot = m.snapshot(50);
            assert_eq!(snapshot.display_state, display_state);
            assert_eq!(snapshot.activity_state, activity_state);
            assert_eq!(snapshot.activity_since, Some(50));
            assert_eq!(snapshot.idle_stage, IdleStage::None);
        }
    }

    #[test]
    fn meaningful_activity_resets_the_eligible_idle_interval() {
        let mut m = Machine::new();
        m.apply(&ev("s", 0, HookKind::SessionStart));
        assert_eq!(m.snapshot(HOUR).idle_stage, IdleStage::Fish);

        m.apply(&ev("s", HOUR, HookKind::UserPromptSubmit));
        let active = m.snapshot(HOUR);
        assert_eq!(active.activity_state, ActivityState::Active);
        assert_eq!(active.activity_since, Some(HOUR));
        assert_eq!(active.idle_stage, IdleStage::None);

        m.apply(&ev(
            "s",
            HOUR + MIN,
            HookKind::Stop {
                ends_with_question: false,
            },
        ));
        assert_eq!(
            m.snapshot(HOUR + MIN + SLACKING_FRESH_MS - 1).idle_stage,
            IdleStage::None
        );
        let fresh = m.snapshot(HOUR + MIN + SLACKING_FRESH_MS);
        assert_eq!(fresh.activity_since, Some(HOUR + MIN));
        assert_eq!(fresh.idle_stage, IdleStage::Fresh);
    }

    #[test]
    fn idle_prompt_waiting_gets_legacy_slacking_overlay() {
        let mut m = Machine::new();
        m.apply(&ev(
            "s",
            0,
            HookKind::Notification {
                kind: Some("idle_prompt".into()),
            },
        ));
        let snapshot = m.snapshot(SLACKING_FRESH_MS);
        assert_eq!(snapshot.display_state, DisplayState::Waiting);
        assert_eq!(snapshot.activity_state, ActivityState::EligibleIdle);
        assert_eq!(snapshot.idle_stage, IdleStage::Fresh);
        assert_eq!(snapshot.legacy_state(), State::SlackingFresh);
    }

    #[test]
    fn approval_waiting_never_gets_legacy_slacking_overlay_while_live() {
        let mut m = Machine::new();
        m.apply(&ev("s", 0, HookKind::PermissionRequest));
        let snapshot = m.snapshot(HOUR);
        assert_eq!(snapshot.display_state, DisplayState::Waiting);
        assert_eq!(snapshot.activity_state, ActivityState::Waiting);
        assert_eq!(snapshot.idle_stage, IdleStage::None);
        assert_eq!(snapshot.legacy_state(), State::Waiting);
    }

    #[test]
    fn adding_an_eligible_session_preserves_existing_interval() {
        let mut m = Machine::new();
        m.apply(&ev("a", 0, HookKind::SessionStart));
        m.apply(&ev("b", 59 * MIN, HookKind::SessionStart));
        let snapshot = m.snapshot(HOUR);
        assert_eq!(snapshot.activity_state, ActivityState::EligibleIdle);
        assert_eq!(snapshot.activity_since, Some(0));
        assert_eq!(snapshot.idle_stage, IdleStage::Fish);
    }

    #[test]
    fn any_live_active_or_blocked_session_prevents_idle_accounting() {
        let mut active = Machine::new();
        active.apply(&ev(
            "idle",
            0,
            HookKind::Stop {
                ends_with_question: false,
            },
        ));
        active.apply(&ev("busy", HOUR, HookKind::UserPromptSubmit));
        assert_eq!(active.snapshot(HOUR).activity_state, ActivityState::Active);
        assert_eq!(active.snapshot(HOUR).idle_stage, IdleStage::None);

        let mut waiting = Machine::new();
        waiting.apply(&ev("idle", 0, HookKind::SessionStart));
        waiting.apply(&ev("blocked", HOUR, HookKind::PermissionRequest));
        assert_eq!(
            waiting.snapshot(HOUR).activity_state,
            ActivityState::Waiting
        );
        assert_eq!(waiting.snapshot(HOUR).idle_stage, IdleStage::None);
    }

    #[test]
    fn multiple_blockers_start_global_idle_at_last_ttl_expiry() {
        let mut m = Machine::new();
        m.apply(&ev(
            "failed",
            0,
            HookKind::Notification {
                kind: Some("error".into()),
            },
        ));
        m.apply(&ev("waiting", 0, HookKind::PermissionRequest));

        let first_expired = m.snapshot(HOUR + 1);
        assert_eq!(first_expired.activity_state, ActivityState::Waiting);
        assert_eq!(first_expired.idle_stage, IdleStage::None);

        let all_expired = m.snapshot(DAY + 1);
        assert_eq!(all_expired.activity_state, ActivityState::EligibleIdle);
        assert_eq!(all_expired.activity_since, Some(DAY + 1));
        assert_eq!(all_expired.idle_stage, IdleStage::None);
    }

    #[test]
    fn pruning_expired_blocker_does_not_backdate_global_idle_anchor() {
        let mut m = Machine::new();
        m.apply(&ev(
            "idle",
            0,
            HookKind::Stop {
                ends_with_question: false,
            },
        ));
        m.apply(&ev(
            "failed",
            100,
            HookKind::Notification {
                kind: Some("error".into()),
            },
        ));

        // This informational event materializes and prunes the expired Failed
        // entry, but must preserve the exact new interval boundary.
        let decay_at = 100 + HOUR + 1;
        m.apply(&ev(
            "transport",
            decay_at,
            HookKind::Notification {
                kind: Some("info".into()),
            },
        ));
        assert_eq!(m.tracked_sessions(), 1); // Done remains; expired Failed is pruned.
        let snapshot = m.snapshot(decay_at);
        assert_eq!(snapshot.activity_since, Some(decay_at));
        assert_eq!(snapshot.idle_stage, IdleStage::None);
        assert_eq!(
            m.snapshot(decay_at + SLACKING_FRESH_MS).idle_stage,
            IdleStage::Fresh
        );
    }

    #[test]
    fn received_order_wins_when_the_source_clock_moves_backward() {
        let mut m = Machine::new();
        m.apply_at(&ev("s", 2_000, HookKind::UserPromptSubmit), 10_000);
        m.apply_at(
            &ev(
                "s",
                1_000,
                HookKind::Stop {
                    ends_with_question: false,
                },
            ),
            11_000,
        );
        let snapshot = m.snapshot(11_000);
        assert_eq!(snapshot.display_state, DisplayState::Done);
        assert_eq!(snapshot.activity_state, ActivityState::EligibleIdle);
        assert_eq!(snapshot.activity_since, Some(11_000));
    }

    #[test]
    fn source_clock_changes_do_not_interfere_across_sessions() {
        let mut m = Machine::new();
        m.apply(&ev("a", 100, HookKind::UserPromptSubmit));
        m.apply(&ev("b", 200, HookKind::UserPromptSubmit));
        m.apply(&ev(
            "a",
            150,
            HookKind::Stop {
                ends_with_question: false,
            },
        ));
        m.apply(&ev("a", 180, HookKind::PermissionRequest));

        let snapshot = m.snapshot(200);
        assert_eq!(snapshot.display_state, DisplayState::Waiting);
        assert_eq!(snapshot.activity_state, ActivityState::Waiting);
        // B advanced the accepted timeline to 200, but A's lower observed wall
        // clock values are not mistaken for a replay sequence.
        assert_eq!(snapshot.activity_since, Some(200));
    }

    #[test]
    fn delayed_event_after_prune_is_accepted_at_receive_time_without_backdating() {
        let mut m = Machine::new();
        m.apply_at(&ev("s", 100_000, HookKind::UserPromptSubmit), 100_000);
        let decay_at = 100_000 + 3 * MIN + 1;
        m.apply_at(
            &ev(
                "transport",
                decay_at,
                HookKind::Notification {
                    kind: Some("info".into()),
                },
            ),
            decay_at,
        );
        assert_eq!(m.tracked_sessions(), 0);

        let received_at = decay_at + MIN;
        m.apply_at(&ev("s", 60_000, HookKind::PermissionRequest), received_at);
        let snapshot = m.snapshot(received_at);
        assert_eq!(snapshot.display_state, DisplayState::Waiting);
        assert_eq!(snapshot.activity_state, ActivityState::Waiting);
        assert_eq!(snapshot.activity_since, Some(received_at));
        assert_eq!(snapshot.idle_stage, IdleStage::None);
    }

    #[test]
    fn apply_at_uses_receive_time_for_authoritative_boundaries() {
        let mut m = Machine::new();
        m.apply_at(&ev("s", 1, HookKind::SessionStart), HOUR);

        let accepted = m.snapshot(HOUR);
        assert_eq!(accepted.display_since, Some(HOUR));
        assert_eq!(accepted.activity_state, ActivityState::EligibleIdle);
        assert_eq!(accepted.activity_since, Some(HOUR));
        assert_eq!(accepted.idle_stage, IdleStage::None);
        assert_eq!(
            m.snapshot(HOUR + SLACKING_FRESH_MS).idle_stage,
            IdleStage::Fresh
        );
    }

    #[test]
    fn observed_clock_skew_cannot_fast_forward_or_backdate_idle() {
        for observed_at in [0, u64::MAX] {
            let mut m = Machine::new();
            m.apply_at(&ev("s", observed_at, HookKind::SessionStart), HOUR);
            assert_eq!(m.snapshot(HOUR).idle_stage, IdleStage::None);
            let fresh = m.snapshot(HOUR + SLACKING_FRESH_MS);
            assert_eq!(fresh.activity_since, Some(HOUR));
            assert_eq!(fresh.idle_stage, IdleStage::Fresh);
        }

        let mut m = Machine::new();
        m.apply_at(&ev("s", u64::MAX, HookKind::SessionStart), HOUR);
        m.apply_at(&ev("s", 1, HookKind::UserPromptSubmit), HOUR + 1);
        let recovered = m.snapshot(HOUR + 1);
        assert_eq!(recovered.display_state, DisplayState::Working);
        assert_eq!(recovered.activity_state, ActivityState::Active);
        assert_eq!(recovered.activity_since, Some(HOUR + 1));
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
