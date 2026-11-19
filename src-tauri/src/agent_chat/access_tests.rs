use super::*;

#[test]
fn a_refusal_of_our_own_mode_change_is_picked_out_of_the_stream() {
    let refused = json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": "octiq-access-1",
            "error": "Cannot set permission mode to bypassPermissions \
                      because the session was not launched with \
                      --dangerously-skip-permissions"
        }
    });
    assert!(provider_for(ChatAgent::Claude)
        .observe_event(&refused)
        .access_refusal
        .expect("a refusal")
        .contains("bypassPermissions"));
}

#[test]
fn nothing_else_on_the_wire_is_mistaken_for_one() {
    // Our own success, somebody else's control request, and an ordinary
    // message. None of these means the picker is lying about the level.
    let ours_worked = json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": "octiq-access-1" }
    });
    let someone_elses = json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": "int-1", "error": "no" }
    });
    let a_message = json!({ "type": "assistant", "message": { "content": [] } });
    let provider = provider_for(ChatAgent::Claude);
    assert!(provider
        .observe_event(&ours_worked)
        .access_refusal
        .is_none());
    assert!(provider
        .observe_event(&someone_elses)
        .access_refusal
        .is_none());
    assert!(provider.observe_event(&a_message).access_refusal.is_none());
}
