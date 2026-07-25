use wb_buddy_core::{ActivityState, DisplayState, Event, HookKind, Machine};

#[test]
fn multi_session_arbitration_can_produce_waiting_active() {
    let mut machine = Machine::new();
    machine.apply(&Event {
        session_id: "idle-prompt".into(),
        ts: 1,
        kind: HookKind::Notification {
            kind: Some("idle_prompt".into()),
        },
    });
    machine.apply(&Event {
        session_id: "active-prompt".into(),
        ts: 2,
        kind: HookKind::UserPromptSubmit,
    });

    let snapshot = machine.snapshot(2);
    assert_eq!(snapshot.display_state, DisplayState::Waiting);
    assert_eq!(snapshot.activity_state, ActivityState::Active);
}
