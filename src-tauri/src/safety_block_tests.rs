use super::*;

const EXTERNAL: &str = "2026-09-05T12:44:54Z ERROR codex_core::tools::router: \
error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: This command would send local outline and constraints to the external DeepSeek/OpenCode service without explicit approval.\\nThe agent must stop and request user input.\\\")\" }";

const OBSERVED_EXTERNAL: &str = "2026-09-05T12:44:54.840971Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: 该命令会将本地私有 outline 与 constraints 发送给外部 DeepSeek/OpenCode 服务；用户只授权先写 outline，未明确授权这些具体内容向该目的地外传。\\nThe agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention.\\\")\" }";

const MODERN_REJECTION: &str = "2026-09-17T01:00:00Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \"Rejected(\\\"This action was rejected due to unacceptable risk.\\nReason: 该命令会上传新的 3D 构图参考并创建一次 3-credit 生成任务。\\nDo not bypass this rejection through a workaround or indirect execution. Complete unaffected work without asking for confirmation. Report anything that remains blocked and ask for approval.\\\")\" }";

#[test]
fn external_transfer_rejection_becomes_a_clear_block() {
    let (summary, detail) = complete_safety_rejection(EXTERNAL).expect("the safety block");

    assert!(summary.contains("DeepSeek/OpenCode"));
    assert!(summary.contains("outline and constraints"));
    assert!(detail.starts_with("This action was rejected"));
    assert!(detail.contains("\nReason:"));
    assert!(!detail.contains("\\n"));
}

#[test]
fn ordinary_router_rejections_stay_diagnostics_only() {
    let denied_delete = "2026-09-01T03:56:54Z ERROR codex_core::tools::router: \
error=exec_command failed: CreateProcess { message: Rejected: rm -f is not permitted }";

    assert!(complete_safety_rejection(denied_delete).is_none());
}

#[test]
fn the_observed_localised_rejection_keeps_its_specific_reason() {
    let (summary, detail) =
        complete_safety_rejection(OBSERVED_EXTERNAL).expect("the observed safety block");

    assert!(summary.starts_with("该命令会将本地私有 outline"));
    assert!(summary.contains("DeepSeek/OpenCode"));
    assert!(!summary.contains("The agent must"));
    assert!(detail.contains("This action was rejected due to unacceptable risk."));
}

#[test]
fn approval_text_keeps_only_the_reason_not_the_reviewers_follow_up_commands() {
    let (summary, _) =
        complete_safety_rejection(MODERN_REJECTION).expect("the modern safety block");

    assert_eq!(
        summary,
        "该命令会上传新的 3D 构图参考并创建一次 3-credit 生成任务。"
    );
    assert!(!summary.contains("ask for approval"));
    assert!(!summary.contains("Do not bypass"));
}

#[test]
fn a_saved_grant_is_reloaded_only_for_the_same_project() {
    let root = crate::test_dir::TestDir::new("safety-authorizations");
    let other = root.with_extension("other-project");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&other).unwrap();
    let path = root.join("grants.json");
    let scope = normalized_scope(root.to_str().unwrap()).unwrap();
    let block = BlockedAction {
        id: "blocked-1".into(),
        chat_key: "chat:one".into(),
        kind: "external-data",
        title: "Codex blocked external data sharing",
        summary: "Send these four character references to Higgsfield for the landing page.".into(),
        detail: "review detail".into(),
        project_scope: Some(scope),
        provider: "codex",
        action: None,
        count: None,
        commands: Vec::new(),
        guidance: None,
        refusals: Vec::new(),
        allow: None,
        written: None,
        writing: false,
        close_after_write: None,
        rules: Vec::new(),
        uncovered: Vec::new(),
    };

    save_authorization(&path, &block).unwrap();
    // The same click or delivery retry is idempotent.
    save_authorization(&path, &block).unwrap();
    let stored = read_authorizations(&path).unwrap();
    assert_eq!(stored.authorizations.len(), 1);

    let prompt = project_authorizations_at(&path, root.to_str().unwrap()).unwrap();
    assert!(prompt.contains("Higgsfield"));
    assert!(prompt.contains("Do not ask the person again"));
    assert!(project_authorizations_at(&path, other.to_str().unwrap()).is_none());

    fs::remove_file(&path).unwrap();
    fs::remove_dir(&root).unwrap();
    fs::remove_dir(&other).unwrap();
}

fn classifier_denial(tool: &str, id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "[Production Deploy]", "decision_reason_type": "classifier",
        "message": "Permission for this action was denied by the Claude Code auto mode classifier.",
        "tool_name": tool, "tool_use_id": id,
    })
}

#[test]
fn a_claude_classifier_refusal_becomes_a_card_naming_the_exact_call() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let input = serde_json::json!({ "command": "eas update --branch production" });
    assert!(observe_claude_denial(
        &chat,
        None,
        &classifier_denial("Bash", "toolu_1"),
        Some(("Bash", &input))
    ));
    // The same refusal, seen twice, is still one decision.
    assert!(!observe_claude_denial(
        &chat,
        None,
        &classifier_denial("Bash", "toolu_1"),
        Some(("Bash", &input))
    ));
    let card = pending().into_iter().find(|b| b.chat_key == chat).unwrap();
    assert_eq!(card.provider, "claude");
    assert_eq!(card.summary, "Production Deploy");
    assert_eq!(
        card.action.as_deref(),
        Some("eas update --branch production")
    );
    // What the browser sees offers nothing to approve: no rule, no grant.
    let shown = serde_json::to_value(&card).unwrap();
    assert!(shown.get("exactGrant").is_none(), "{shown}");
    assert!(!shown.to_string().contains("Bash("), "{shown}");
    // A Claude card cannot be turned into a project-wide instruction.
    assert!(authorize_for_project(&card.id).is_err());
    assert!(dismiss(&card.id));
    assert_eq!(decision(&card.id), Some("dismissed"));
}

/// Claude 2.1.x's own words for an outage, verbatim from a worker
/// transcript of run 8eb35d0a.
const OUTAGE_MESSAGE: &str = "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action: a later response may get a verdict. You may try the action again once, as-is.";

fn outage_denial(id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "Classifier unavailable", "decision_reason_type": "classifier",
        "message": OUTAGE_MESSAGE, "tool_name": "Bash", "tool_use_id": id,
    })
}

fn bash(line: &str) -> serde_json::Value {
    serde_json::json!({ "command": line })
}

fn cards_in(chat: &str) -> Vec<BlockedAction> {
    pending()
        .into_iter()
        .filter(|b| b.chat_key == chat)
        .collect()
}

#[test]
fn only_the_exact_classifier_unavailable_reason_is_an_outage() {
    // The string seen on 2026-09-28, and harmless variations of it.
    assert_eq!(
        refusal_kind(Some("Classifier unavailable")),
        RefusalKind::Outage
    );
    assert_eq!(
        refusal_kind(Some("  classifier UNAVAILABLE ")),
        RefusalKind::Outage
    );
    assert_eq!(
        refusal_kind(Some("[Classifier unavailable]")),
        RefusalKind::Outage
    );
    // Anything else is a safety refusal: when unsure, it is one.
    assert_eq!(refusal_kind(None), RefusalKind::Safety);
    assert_eq!(refusal_kind(Some("")), RefusalKind::Safety);
    assert_eq!(refusal_kind(Some("   ")), RefusalKind::Safety);
    assert_eq!(refusal_kind(Some("Production Deploy")), RefusalKind::Safety);
    assert_eq!(
        refusal_kind(Some("Production Deploy (Classifier unavailable earlier)")),
        RefusalKind::Safety
    );
    assert_eq!(
        refusal_kind(Some("Classifier unavailable: Production Deploy")),
        RefusalKind::Safety
    );
    assert_eq!(refusal_kind(Some("Classifier")), RefusalKind::Safety);
    assert_eq!(refusal_kind(Some("unavailable")), RefusalKind::Safety);
}

#[test]
fn a_classifier_denial_without_the_outage_reason_is_still_a_safety_card() {
    // decision_reason_type "classifier" alone proves nothing: real
    // refusals carry it too.
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let mut missing = outage_denial("toolu_m");
    missing.as_object_mut().unwrap().remove("decision_reason");
    assert!(observe_claude_denial(
        &chat,
        None,
        &missing,
        Some(("Bash", &bash("ls")))
    ));
    let mut empty = outage_denial("toolu_e");
    empty["decision_reason"] = "".into();
    assert!(observe_claude_denial(
        &chat,
        None,
        &empty,
        Some(("Bash", &bash("ls")))
    ));
    let cards = cards_in(&chat);
    assert_eq!(cards.len(), 2, "one card per safety refusal, never grouped");
    for card in &cards {
        assert_eq!(card.title, "Claude's auto mode blocked an action");
        assert_eq!(card.kind, "high-risk-action");
        assert!(card.guidance.is_none());
        assert!(card.refusals.is_empty());
    }
    forget_chat(&chat);
}

#[test]
fn outage_refusals_in_one_window_are_one_card_with_a_count() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let t = 1_000_000;
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_a"),
        Some(("Bash", &bash("git fetch"))),
        t
    ));
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_b"),
        Some(("Bash", &bash("ls docs"))),
        t + 20_000
    ));
    // The same line re-sent after a refusal collapses to one row.
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_c"),
        Some(("Bash", &bash("git fetch"))),
        t + 40_000
    ));
    // The same refusal seen twice is not a second refusal.
    assert!(!observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_c"),
        Some(("Bash", &bash("git fetch"))),
        t + 41_000
    ));

    let cards = cards_in(&chat);
    assert_eq!(cards.len(), 1);
    let card = &cards[0];
    assert_eq!(card.title, OUTAGE_TITLE);
    assert_eq!(card.kind, "outage");
    assert_eq!(card.count, Some(3));
    let shown = serde_json::to_value(card).unwrap();
    assert_eq!(shown["count"], 3);
    assert_eq!(shown["commands"][0]["action"], "git fetch");
    assert_eq!(shown["commands"][0]["count"], 2);
    assert_eq!(shown["commands"][1]["action"], "ls docs");
    assert_eq!(shown["commands"][1]["count"], 1);
    assert_eq!(shown["guidance"], outage_guidance());
    assert!(!shown.to_string().contains("blocked an action"));
    assert!(card.detail.contains("not a judgment about the action"));
    assert!(card.detail.contains("toolu_a, toolu_b, toolu_c"));

    // Every refusal stays its own ledger entry, under the card's id.
    let summaries: Vec<_> = decision_summaries()
        .into_iter()
        .filter(|s| s.chat_key == chat)
        .collect();
    assert_eq!(summaries.len(), 3);
    assert!(summaries
        .iter()
        .all(|s| s.kind == RefusalKind::Outage && s.group_id.as_deref() == Some(card.id.as_str())));

    // One dismiss closes the whole group.
    assert!(dismiss(&card.id));
    assert!(cards_in(&chat).is_empty());
    assert!(decision_summaries().iter().all(|s| s.chat_key != chat));
    // A later outage starts a new card rather than reviving that one.
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_d"),
        Some(("Bash", &bash("ls"))),
        t + 50_000
    ));
    let again = cards_in(&chat);
    assert_eq!(again.len(), 1);
    assert_ne!(again[0].id, card.id);
    forget_chat(&chat);
}

fn temp_dir(label: &str) -> crate::test_dir::TestDir {
    crate::test_dir::TestDir::new(label)
}

fn mcp_outage(id: &str, tool: &str) -> serde_json::Value {
    let mut event = outage_denial(id);
    event["tool_name"] = tool.into();
    event
}

#[test]
fn an_outage_card_names_each_calls_narrowest_rule() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("allow-project");
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    let t = 2_000_000;
    for (id, tool, input) in [
        ("toolu_1", "Bash", bash("git push origin main")),
        ("toolu_2", "Bash", bash("ls | wc -l")),
        (
            "toolu_3",
            "mcp__claude_ai_Higgfield__media_upload",
            serde_json::json!({"path": "a.png"}),
        ),
    ] {
        assert!(observe_claude_denial_at(
            &chat,
            &mcp_outage(id, tool),
            Some((tool, &input)),
            t
        ));
    }
    let card = cards_in(&chat).pop().unwrap();
    let shown = serde_json::to_value(&card).unwrap();
    assert_eq!(shown["commands"][0]["tool"], "Bash");
    assert_eq!(shown["commands"][0]["words"], "git push");
    assert_eq!(shown["commands"][0]["rule"], "Bash(git push:*)");
    // A piped line gets no rule: only a retry is offered for it.
    assert!(shown["commands"][1].get("rule").is_none());
    assert_eq!(
        shown["commands"][2]["rule"],
        "mcp__claude_ai_Higgfield__media_upload"
    );
    assert!(shown["commands"][2].get("words").is_none());
    assert_eq!(
        shown["allow"]["project"],
        project
            .join(".claude")
            .join("settings.local.json")
            .to_str()
            .unwrap()
    );
    assert!(shown["allow"]["user"]
        .as_str()
        .unwrap()
        .ends_with("settings.json"));
    // Never a blanket rule, anywhere on the card.
    for command in shown["commands"].as_array().unwrap() {
        let rule = command
            .get("rule")
            .and_then(|r| r.as_str())
            .unwrap_or_default();
        assert!(
            rule != "Bash" && rule != "Bash(*)" && rule != "*",
            "{command}"
        );
    }
    forget_chat(&chat);
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn always_allow_in_this_project_writes_the_rule_and_closes_the_card() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("allow-project");
    let settings = project.join(".claude").join("settings.local.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(&settings, "{\n  \"env\": {\"A\": \"1\"}\n}\n").unwrap();
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_p1"),
        Some(("Bash", &bash("cd sub && git push origin HEAD"))),
        3_000_000
    ));
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_p2"),
        Some(("Bash", &bash("python x.py"))),
        3_000_100
    ));
    let card = cards_in(&chat).pop().unwrap();
    let done = allow_outage(&card.id, crate::claude_allow::Scope::Project).unwrap();
    let done = serde_json::to_value(done).unwrap();
    assert_eq!(done["rules"], serde_json::json!(["Bash(git push:*)"]));
    assert_eq!(done["added"], serde_json::json!(["Bash(git push:*)"]));
    assert_eq!(done["uncovered"], serde_json::json!(["python x.py"]));
    assert_eq!(done["path"], settings.to_str().unwrap());
    let written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(written["env"]["A"], "1");
    assert_eq!(
        written["permissions"]["allow"],
        serde_json::json!(["Bash(git push:*)"])
    );
    // Never the shared file.
    assert!(!project.join(".claude").join("settings.json").exists());

    // Review finding (5bf9f85): the card came down, and the decision was
    // recorded, before the retry turn was queued, so a send that failed
    // in between lost the retry. The card now stays up, undecided, until
    // the page says the turn is queued.
    let still = cards_in(&chat);
    assert_eq!(still.len(), 1, "a written rule leaves the card up");
    assert_eq!(
        serde_json::to_value(&still[0]).unwrap()["written"],
        "project"
    );
    assert_eq!(decision(&card.id), None);
    // The send failed; the person clicks again. Nothing is added twice.
    let again =
        serde_json::to_value(allow_outage(&card.id, crate::claude_allow::Scope::Project).unwrap())
            .unwrap();
    assert_eq!(again["added"], serde_json::json!([]));
    assert_eq!(again["present"], serde_json::json!(["Bash(git push:*)"]));
    // The retry turn is queued: now it is decided, as the allow it wrote.
    assert_eq!(retry_outage(&card.id), Ok(true));
    assert!(cards_in(&chat).is_empty());
    assert_eq!(decision(&card.id), Some("allowed_project"));
    // The card is gone: a further click writes nothing.
    assert!(allow_outage(&card.id, crate::claude_allow::Scope::Project).is_err());
    assert!(retry_outage(&card.id).is_err());
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn always_allow_everywhere_writes_claude_config_dir_settings() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("allow-project");
    let config = temp_dir("allow-config");
    remember_claude_launch(
        &chat,
        true,
        project.to_str().unwrap(),
        false,
        Some(config.to_string_lossy().into_owned()),
    );
    let tool = "mcp__claude_ai_Higgfield__media_upload";
    assert!(observe_claude_denial_at(
        &chat,
        &mcp_outage("toolu_u1", tool),
        Some((tool, &serde_json::json!({}))),
        4_000_000
    ));
    let card = cards_in(&chat).pop().unwrap();
    let done = allow_outage(&card.id, crate::claude_allow::Scope::User).unwrap();
    let done = serde_json::to_value(done).unwrap();
    let canonical = config.canonical().unwrap().join("settings.json");
    assert_eq!(done["path"], canonical.to_str().unwrap());
    assert_eq!(
        serde_json::to_value(&card).unwrap()["allow"]["user"],
        canonical.to_str().unwrap()
    );
    let written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config.join("settings.json")).unwrap()).unwrap();
    assert_eq!(written["permissions"]["allow"], serde_json::json!([tool]));
    assert!(
        !project.join(".claude").exists(),
        "the project was not touched"
    );
    assert_eq!(
        decision(&card.id),
        None,
        "undecided until the retry is queued"
    );
    assert_eq!(retry_outage(&card.id), Ok(true));
    assert_eq!(decision(&card.id), Some("allowed_user"));
    fs::remove_dir_all(project).unwrap();
    fs::remove_dir_all(config).unwrap();
}

/// Review finding (5bf9f85): a project that sets
/// `CLAUDE_CONFIG_DIR=<repo>/.claude` must not turn "Always allow
/// everywhere" into a write to the project's shared settings.json. The
/// card leaves that button out, and a page that asks anyway is refused.
#[test]
fn everywhere_is_not_offered_for_a_config_dir_inside_the_project() {
    let project = temp_dir("allow-project");
    let shared = project.join(".claude").join("settings.json");
    fs::create_dir_all(shared.parent().unwrap()).unwrap();
    fs::write(&shared, "{}\n").unwrap();
    for config_dir in [
        project.join(".claude").to_string_lossy().into_owned(),
        ".claude".to_string(),
        "./sub/../.claude".to_string(),
    ] {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        remember_claude_launch(
            &chat,
            true,
            project.to_str().unwrap(),
            false,
            Some(config_dir.clone()),
        );
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial("toolu_s"),
            Some(("Bash", &bash("git push origin main"))),
            7_000_000
        ));
        let card = cards_in(&chat).pop().unwrap();
        let shown = serde_json::to_value(&card).unwrap();
        assert!(
            shown["allow"].get("user").is_none(),
            "{config_dir}: {shown}"
        );
        assert!(shown["allow"]["project"].is_string(), "project scope stays");
        let err = allow_outage(&card.id, crate::claude_allow::Scope::User).unwrap_err();
        assert!(err.contains("not your own"), "{err}");
        assert_eq!(cards_in(&chat).len(), 1);
        forget_chat(&chat);
    }
    assert_eq!(fs::read_to_string(&shared).unwrap(), "{}\n");
    fs::remove_dir_all(project).unwrap();
}

/// A relative CLAUDE_CONFIG_DIR is read from the folder Claude was
/// launched in, never from this server's own.
#[test]
fn a_relative_config_dir_is_the_launch_folders() {
    let root = temp_dir("allow-relative");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(root.join("personal")).unwrap();
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    remember_claude_launch(
        &chat,
        true,
        project.to_str().unwrap(),
        false,
        Some("../personal".into()),
    );
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_rel"),
        Some(("Bash", &bash("git push origin main"))),
        8_000_000
    ));
    let card = cards_in(&chat).pop().unwrap();
    let expected = root
        .join("personal")
        .canonical()
        .unwrap()
        .join("settings.json");
    assert_eq!(
        serde_json::to_value(&card).unwrap()["allow"]["user"],
        expected.to_str().unwrap()
    );
    let done =
        serde_json::to_value(allow_outage(&card.id, crate::claude_allow::Scope::User).unwrap())
            .unwrap();
    assert_eq!(done["path"], expected.to_str().unwrap());
    assert!(expected.is_file());
    forget_chat(&chat);
}

#[test]
fn allow_is_refused_where_a_rule_would_change_nothing_or_is_not_the_persons() {
    let project = temp_dir("allow-project");
    let settings = project.join(".claude").join("settings.local.json");

    // A lite chat reads no settings file: no targets, and a refusal.
    let lite = format!("chat:test-{}", uuid::Uuid::new_v4());
    remember_claude_launch(&lite, true, project.to_str().unwrap(), true, None);
    assert!(observe_claude_denial_at(
        &lite,
        &outage_denial("toolu_l"),
        Some(("Bash", &bash("git push"))),
        5_000_000
    ));
    let card = cards_in(&lite).pop().unwrap();
    assert!(serde_json::to_value(&card).unwrap().get("allow").is_none());
    assert!(allow_outage(&card.id, crate::claude_allow::Scope::Project).is_err());
    assert!(
        !cards_in(&lite).is_empty(),
        "a refused allow leaves the card up"
    );
    forget_chat(&lite);

    // A chat whose Claude launch was never seen (or is Codex's now).
    let codex = format!("chat:test-{}", uuid::Uuid::new_v4());
    remember_claude_launch(&codex, true, project.to_str().unwrap(), false, None);
    remember_claude_launch(&codex, false, project.to_str().unwrap(), false, None);
    assert!(observe_claude_denial_at(
        &codex,
        &outage_denial("toolu_c"),
        Some(("Bash", &bash("git push"))),
        5_000_000
    ));
    let card = cards_in(&codex).pop().unwrap();
    assert!(allow_outage(&card.id, crate::claude_allow::Scope::User).is_err());
    forget_chat(&codex);

    // Only calls no rule covers: retry only.
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_n"),
        Some(("Bash", &bash("a && b"))),
        5_000_000
    ));
    let card = cards_in(&chat).pop().unwrap();
    let err = allow_outage(&card.id, crate::claude_allow::Scope::Project).unwrap_err();
    assert!(err.contains("Retry once"), "{err}");
    forget_chat(&chat);

    // A judged refusal: the refusal stands. The card may OFFER the exact
    // rule (`allow_judged`), but nothing is written or retried by seeing
    // it, and the outage commands do not reach it.
    let judged = format!("chat:test-{}", uuid::Uuid::new_v4());
    remember_claude_launch(&judged, true, project.to_str().unwrap(), false, None);
    assert!(observe_claude_denial(
        &judged,
        None,
        &classifier_denial("Bash", "toolu_j"),
        Some(("Bash", &bash("git push")))
    ));
    let card = cards_in(&judged).pop().unwrap();
    assert_eq!(card.kind, "high-risk-action");
    let shown = serde_json::to_value(&card).unwrap();
    assert_eq!(
        shown["rules"],
        serde_json::json!(["Bash(git push)"]),
        "{shown}"
    );
    assert!(!shown.to_string().contains(":*"), "{shown}");
    assert!(allow_outage(&card.id, crate::claude_allow::Scope::Project).is_err());
    assert!(retry_outage(&card.id).is_err());
    assert!(!cards_in(&judged).is_empty());
    forget_chat(&judged);

    assert!(!settings.exists(), "no refusal wrote anything");
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn retry_once_closes_an_outage_card_and_writes_nothing() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("allow-project");
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_r"),
        Some(("Bash", &bash("git push"))),
        6_000_000
    ));
    let card = cards_in(&chat).pop().unwrap();
    assert_eq!(retry_outage(&card.id), Ok(true));
    assert_eq!(decision(&card.id), Some("retried"));
    assert!(cards_in(&chat).is_empty());
    assert!(!project.join(".claude").exists());
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn an_outage_group_closes_after_its_window_its_age_cap_or_its_count_cap() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let t = 5_000_000;
    let refuse = |id: &str, at: i64| {
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial(id),
            Some(("Bash", &bash(id))),
            at
        ));
    };
    // Quiet for longer than the window: a new group.
    refuse("w1", t);
    refuse("w2", t + OUTAGE_WINDOW_MS);
    assert_eq!(cards_in(&chat).len(), 2);
    forget_chat(&chat);

    // Refused every 90 seconds: the window never lapses, but the group
    // closes five minutes after it opened.
    let t = t + 60 * 60_000;
    for (n, at) in [0, 90_000, 180_000, 270_000].iter().enumerate() {
        refuse(&format!("a{n}"), t + at);
    }
    assert_eq!(cards_in(&chat).len(), 1);
    refuse("a4", t + OUTAGE_MAX_OPEN_MS);
    assert_eq!(cards_in(&chat).len(), 2);
    forget_chat(&chat);

    // Five refusals in quick succession fill a group.
    let t = t + 60 * 60_000;
    for n in 0..OUTAGE_MAX_REFUSALS as i64 {
        refuse(&format!("c{n}"), t + n * 1_000);
    }
    assert_eq!(cards_in(&chat).len(), 1);
    refuse("c5", t + 6_000);
    let cards = cards_in(&chat);
    assert_eq!(cards.len(), 2);
    assert!(cards.iter().any(|c| c.count == Some(OUTAGE_MAX_REFUSALS)));
    assert!(cards.iter().any(|c| c.count == Some(1)));
    forget_chat(&chat);
}

/// The one as-is retry a worker may make, refused again, is a repeat in
/// the same group: collapsed as ×2, and counted towards the cap.
#[test]
fn a_refused_retry_is_a_repeat_that_counts_towards_the_cap() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let t = 9_000_000;
    let refuse = |id: &str, line: &str, at: i64| {
        assert!(observe_claude_denial_at(
            &chat,
            &outage_denial(id),
            Some(("Bash", &bash(line))),
            at
        ));
    };
    refuse("r1", "git fetch", t);
    refuse("r2", "git fetch", t + 5_000); // the retry, refused again
    refuse("r3", "ls", t + 6_000);
    refuse("r4", "cat a", t + 7_000);
    refuse("r5", "cat b", t + 8_000);
    let cards = cards_in(&chat);
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].count, Some(OUTAGE_MAX_REFUSALS));
    assert_eq!(cards[0].commands[0].action, "git fetch");
    assert_eq!(cards[0].commands[0].count, 2);
    assert_eq!(cards[0].commands.len(), 4);
    // Full: the next refusal opens a new group.
    refuse("r6", "git status", t + 9_000);
    assert_eq!(cards_in(&chat).len(), 2);
    forget_chat(&chat);
}

#[test]
fn outage_group_due_is_the_earliest_of_window_age_and_count() {
    assert_eq!(outage_group_due(0, 0, 1), OUTAGE_WINDOW_MS);
    assert_eq!(outage_group_due(0, 250_000, 3), OUTAGE_MAX_OPEN_MS);
    assert_eq!(outage_group_due(0, 10_000, OUTAGE_MAX_REFUSALS), 10_000);
}

/// Pinned word for word, so a change to what workers are told is a
/// visible diff. One as-is retry for classifier outages was decided by
/// the person on 2026-09-28; a second refusal ends it.
#[test]
fn the_outage_guidance_is_pinned_and_allows_exactly_one_as_is_retry() {
    assert_eq!(
            outage_guidance(),
            "Claude's safety check was unavailable, so the command did not run. It was not judged unsafe, and it was not approved. Continue with your other steps. OctiqFlow never re-runs it. You may try the same command once more, as-is: Claude checks that try again. If it is refused again, do not try it a third time. Never reword a command to get past the check. Report every refused command in your worker report, and do not describe any of them as approved or as having run."
        );
    assert!(outage_guidance().contains(OUTAGE_RETRY));
}

#[test]
fn a_refused_call_is_remembered_so_its_result_is_not_work_done() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let id = format!("toolu_{}", uuid::Uuid::new_v4().simple());
    assert!(!was_refused(&id));
    assert!(observe_claude_denial(
        &chat,
        None,
        &outage_denial(&id),
        Some(("Bash", &bash("ls")))
    ));
    assert!(was_refused(&id));
    forget_chat(&chat);
}

/// Review of 2cbc3e9: the record used to be cleared wholesale when full,
/// so a refusal whose result had not come back yet was forgotten and its
/// result read as an allowed call. Only the oldest ids go now.
#[test]
fn a_full_refused_call_record_evicts_only_its_oldest_ids() {
    let mut calls = RefusedCalls::default();
    for n in 0..4 {
        calls.insert(&format!("old{n}"), 4);
    }
    // The fifth refusal, whose result is still to come, arrives full.
    calls.insert("live", 4);
    assert!(calls.contains("live"), "the newest refusal is kept");
    assert!(!calls.contains("old0"), "only the oldest is evicted");
    for n in 1..4 {
        assert!(calls.contains(&format!("old{n}")));
    }
    // Seeing the same refusal again neither duplicates nor evicts.
    calls.insert("live", 4);
    assert!(calls.contains("old1"));
    assert_eq!(calls.order.len(), 4);
    assert_eq!(calls.ids.len(), 4);
    for n in 0..10 {
        calls.insert(&format!("new{n}"), 4);
    }
    assert_eq!(calls.order.len(), 4);
    assert_eq!(calls.ids.len(), 4);
    assert!(calls.contains("new9") && !calls.contains("live"));
}

/// A retry can reuse a worker chat. Its refusals start their own group
/// rather than joining the settled attempt's open one.
#[test]
fn an_outage_group_belongs_to_one_attempt() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let t = 12_000_000;
    let refuse = |id: &str, owner: Option<&str>, at: i64| {
        assert!(observe_claude_refusal(
            &chat,
            owner,
            &outage_denial(id),
            Some(("Bash", &bash("git fetch"))),
            at
        ));
    };
    refuse("g1", Some("attempt-1"), t);
    refuse("g2", Some("attempt-1"), t + 1_000);
    refuse("g3", Some("attempt-2"), t + 2_000);
    refuse("g4", Some("attempt-2"), t + 3_000);
    let cards = cards_in(&chat);
    assert_eq!(cards.len(), 2, "one group per attempt");
    for card in &cards {
        assert_eq!(card.count, Some(2));
        let owners: Vec<_> = card.refusals.iter().map(|r| r.owner.clone()).collect();
        assert_eq!(owners[0], owners[1]);
    }
    let summaries: Vec<_> = decision_summaries()
        .into_iter()
        .filter(|s| s.chat_key == chat)
        .collect();
    assert_eq!(summaries.len(), 4);
    for s in &summaries {
        let card = cards.iter().find(|c| Some(&c.id) == s.group_id.as_ref());
        let card = card.expect("every refusal names its card");
        assert_eq!(s.owner, card.refusals[0].owner);
    }
    forget_chat(&chat);
}

#[test]
fn a_rule_or_person_denial_is_not_a_card() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let mut ruled = classifier_denial("Bash", "toolu_2");
    ruled["decision_reason_type"] = "rule".into();
    assert!(!observe_claude_denial(&chat, None, &ruled, None));
    assert!(pending().iter().all(|b| b.chat_key != chat));

    let chain = serde_json::json!({ "command": "git push && npm publish" });
    assert!(observe_claude_denial(
        &chat,
        None,
        &classifier_denial("Bash", "toolu_3"),
        Some(("Bash", &chain))
    ));
    let card = pending().into_iter().find(|b| b.chat_key == chat).unwrap();
    forget_chat(&chat);
    assert_eq!(decision(&card.id), Some("superseded"));
}

#[test]
fn a_non_codex_provider_never_raises_a_codex_safety_card() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());

    assert!(!observe(AgentKind::Claude, &chat, EXTERNAL));
    assert!(pending().iter().all(|block| block.chat_key != chat));
}

#[test]
fn the_same_rejection_is_one_reload_safe_choice() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());

    assert!(observe(AgentKind::Codex, &chat, EXTERNAL));
    assert!(!observe(AgentKind::Codex, &chat, EXTERNAL));
    let ours = pending()
        .into_iter()
        .filter(|block| block.chat_key == chat)
        .collect::<Vec<_>>();
    assert_eq!(ours.len(), 1);
    assert!(dismiss(&ours[0].id));
    assert!(pending().iter().all(|block| block.chat_key != chat));
}

#[test]
fn a_split_patch_rejection_becomes_one_generic_safety_choice() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let header = "2026-09-07T12:15:53.336267Z ERROR codex_core::tools::router: \
error=This action was rejected due to unacceptable risk.";
    let reason = "Reason: 补丁会伪造质量记录并误导 PR 审查；用户未授权此类不实修改。";
    let policy = "The agent must not attempt to achieve the same outcome via workaround, \
indirect execution, or policy circumvention. Proceed only with a materially safer alternative, \
or if the user explicitly approves the action after being informed of the risk.";

    assert!(!observe(AgentKind::Codex, &chat, header));
    assert!(!observe(AgentKind::Codex, &chat, reason));
    assert!(observe(AgentKind::Codex, &chat, policy));

    let ours = pending()
        .into_iter()
        .filter(|block| block.chat_key == chat)
        .collect::<Vec<_>>();
    assert_eq!(ours.len(), 1);
    assert_eq!(ours[0].kind, "high-risk-action");
    assert_eq!(ours[0].title, "Codex blocked a high-risk action");
    assert_eq!(ours[0].summary, reason.trim_start_matches("Reason: "));
    assert!(ours[0].detail.starts_with("This action was rejected"));
    assert!(ours[0].detail.contains("\nReason:"));
    assert!(ours[0].detail.contains("\nThe agent must"));
    assert!(dismiss(&ours[0].id));
}

/// A judged refusal, as the person saw it on 2026-10-01.
fn judged_denial(id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "system", "subtype": "permission_denied",
        "decision_reason": "[Irreversible Local Destruction]",
        "decision_reason_type": "classifier",
        "message": "Permission for this action was denied by the Claude Code auto mode classifier.",
        "tool_name": "Bash", "tool_use_id": id,
    })
}

const REFUSED_LINE: &str =
    "rm -f web/pnpm-workspace.yaml; git status --short; sed -n '1,80p' web/package.json";

fn judged_card(chat: &str, id: &str, line: &str) -> BlockedAction {
    assert!(observe_claude_denial(
        chat,
        None,
        &judged_denial(id),
        Some(("Bash", &bash(line)))
    ));
    cards_in(chat).pop().unwrap()
}

#[test]
fn a_judged_refusal_card_offers_its_exact_rules_and_where_they_go() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("judged-project");
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    let card = judged_card(&chat, "toolu_j1", REFUSED_LINE);
    assert_eq!(card.kind, "high-risk-action");
    assert_eq!(card.summary, "Irreversible Local Destruction");
    let shown = serde_json::to_value(&card).unwrap();
    assert_eq!(
        shown["rules"],
        serde_json::json!([
            "Bash(rm -f web/pnpm-workspace.yaml)",
            "Bash(git status --short)",
            "Bash(sed -n '1,80p' web/package.json)",
        ])
    );
    assert!(shown.get("uncovered").is_none());
    assert_eq!(
        shown["allow"]["project"],
        project
            .join(".claude")
            .join("settings.local.json")
            .to_str()
            .unwrap()
    );
    assert!(shown["allow"]["user"]
        .as_str()
        .unwrap()
        .ends_with("settings.json"));
    // Nothing was written by seeing it, and it still holds no attempt.
    assert!(!project.join(".claude").exists());
    assert!(!awaits_decision(&chat));
    forget_chat(&chat);
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn a_judged_card_with_nothing_nameable_offers_no_allow() {
    let project = temp_dir("judged-none");
    for (line, tool) in [
        ("python3 -c 'import shutil; shutil.rmtree(\"x\")'", "Bash"),
        ("rm -rf $(pwd)", "Bash"),
        ("rm -rf /", "Bash"),
        ("https://example.com", "WebFetch"),
    ] {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
        let mut event = judged_denial("toolu_n");
        event["tool_name"] = tool.into();
        let input = if tool == "Bash" {
            bash(line)
        } else {
            serde_json::json!({ "url": line })
        };
        assert!(observe_claude_denial(
            &chat,
            None,
            &event,
            Some((tool, &input))
        ));
        let card = cards_in(&chat).pop().unwrap();
        let shown = serde_json::to_value(&card).unwrap();
        assert!(shown.get("rules").is_none(), "{line}: {shown}");
        assert!(shown.get("allow").is_none(), "{line}: {shown}");
        let err = allow_rule(&card.id, crate::claude_allow::Scope::Project).unwrap_err();
        assert!(!err.is_empty());
        assert!(allow_judged(&card.id, crate::claude_allow::Scope::User).is_err());
        assert_eq!(cards_in(&chat).len(), 1, "a refused allow leaves the card");
        forget_chat(&chat);
    }
    assert!(!project.join(".claude").exists(), "nothing was written");
    // A lite chat reads no settings file: no rule would change anything.
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    remember_claude_launch(&chat, true, project.to_str().unwrap(), true, None);
    let card = judged_card(&chat, "toolu_lite", "git push origin main");
    assert!(serde_json::to_value(&card).unwrap().get("rules").is_none());
    assert!(allow_rule(&card.id, crate::claude_allow::Scope::Project).is_err());
    forget_chat(&chat);
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn always_allow_on_a_judged_card_writes_exact_rules_and_closes_with_the_turn() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("judged-allow");
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    let card = judged_card(&chat, "toolu_ja", "node build.js; git push origin main");
    let shown = serde_json::to_value(&card).unwrap();
    assert_eq!(
        shown["rules"],
        serde_json::json!(["Bash(git push origin main)"])
    );
    assert_eq!(shown["uncovered"], serde_json::json!(["node build.js"]));

    // A turn naming the card before any rule exists answers nothing: it
    // supersedes the card like any other turn.
    observe_claude_denial(
        &chat,
        None,
        &judged_denial("toolu_jb"),
        Some(("Bash", &bash("git push origin main"))),
    );
    let other = cards_in(&chat)
        .into_iter()
        .find(|c| c.id != card.id)
        .unwrap();
    assert_eq!(answered_as(&other.id), None);

    let done =
        serde_json::to_value(allow_rule(&card.id, crate::claude_allow::Scope::Project).unwrap())
            .unwrap();
    let settings = project.join(".claude").join("settings.local.json");
    assert_eq!(
        done["rules"],
        serde_json::json!(["Bash(git push origin main)"])
    );
    assert_eq!(
        done["added"],
        serde_json::json!(["Bash(git push origin main)"])
    );
    assert_eq!(done["uncovered"], serde_json::json!(["node build.js"]));
    assert_eq!(done["path"], settings.to_str().unwrap());
    let written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(
        written["permissions"]["allow"],
        serde_json::json!(["Bash(git push origin main)"])
    );
    // Written, but undecided until the turn telling the agent is taken.
    assert_eq!(decision(&card.id), None);
    assert_eq!(answered_as(&card.id), Some("allowed_project"));
    // An outage-only command never closes a judged card.
    assert!(retry_outage(&card.id).is_err());

    // A send that fails leaves both cards up.
    let failed: Result<(), String> =
        person_turn(&chat, Some(&card.id), || Err("no process".into()));
    assert!(failed.is_err());
    assert_eq!(cards_in(&chat).len(), 2);
    // Taken: the card closes as the allow; the card beside it is superseded.
    person_turn(&chat, Some(&card.id), || Ok::<_, String>(())).unwrap();
    assert!(cards_in(&chat).is_empty());
    assert_eq!(decision(&card.id), Some("allowed_project"));
    assert_eq!(decision(&other.id), Some("superseded"));
    assert!(allow_rule(&card.id, crate::claude_allow::Scope::Project).is_err());
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn always_allow_everywhere_on_a_judged_card_writes_the_config_dir() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("judged-project");
    let config = temp_dir("judged-config");
    remember_claude_launch(
        &chat,
        true,
        project.to_str().unwrap(),
        false,
        Some(config.to_string_lossy().into_owned()),
    );
    let card = judged_card(&chat, "toolu_ju", "git status --short; sed -n '1,40p' x.rs");
    let path = config.canonical().unwrap().join("settings.json");
    assert_eq!(
        serde_json::to_value(&card).unwrap()["allow"]["user"],
        path.to_str().unwrap()
    );
    let done = allow_judged(&card.id, crate::claude_allow::Scope::User).unwrap();
    assert_eq!(
        serde_json::to_value(done).unwrap()["path"],
        path.to_str().unwrap()
    );
    let written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        written["permissions"]["allow"],
        serde_json::json!(["Bash(git status --short)", "Bash(sed -n '1,40p' x.rs)"])
    );
    assert!(
        !project.join(".claude").exists(),
        "the project is untouched"
    );
    person_turn(&chat, Some(&card.id), || Ok::<_, String>(())).unwrap();
    assert_eq!(decision(&card.id), Some("allowed_user"));
    fs::remove_dir_all(project).unwrap();
    fs::remove_dir_all(config).unwrap();
}

/// The outage and judged paths do not cross: each card answers only its
/// own commands, and Codex cards answer neither.
#[test]
fn allow_commands_check_the_cards_kind() {
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("judged-kinds");
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    let judged = judged_card(&chat, "toolu_k1", "git push origin main");
    assert!(allow_outage(&judged.id, crate::claude_allow::Scope::Project).is_err());
    assert!(retry_outage(&judged.id).is_err());
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_k2"),
        Some(("Bash", &bash("git push origin main"))),
        now_ms()
    ));
    let outage = cards_in(&chat)
        .into_iter()
        .find(|c| c.kind == "outage")
        .unwrap();
    assert!(allow_judged(&outage.id, crate::claude_allow::Scope::Project).is_err());
    // `allow_rule` sends each to its own path: the outage's prefix rule.
    let done =
        serde_json::to_value(allow_rule(&outage.id, crate::claude_allow::Scope::Project).unwrap())
            .unwrap();
    assert_eq!(done["rules"], serde_json::json!(["Bash(git push:*)"]));
    forget_chat(&chat);

    let codex = format!("chat:test-{}", uuid::Uuid::new_v4());
    for line in [
            "2026-09-07T12:15:53.336267Z ERROR codex_core::tools::router: error=This action was rejected due to unacceptable risk.",
            "Reason: it deletes a folder.",
            "The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention.",
        ] {
            observe(AgentKind::Codex, &codex, line);
        }
    let card = cards_in(&codex).pop().unwrap();
    assert!(allow_rule(&card.id, crate::claude_allow::Scope::Project).is_err());
    assert!(allow_judged(&card.id, crate::claude_allow::Scope::Project).is_err());
    forget_chat(&codex);
    fs::remove_dir_all(project).unwrap();
}

fn allowed_in(settings: &Path, rule: &str) -> bool {
    fs::read_to_string(settings)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json["permissions"]["allow"].as_array().cloned())
        .is_some_and(|rules| rules.iter().any(|r| r == rule))
}

/// Review (Tofu, 2026-10-01): a dismiss racing an allow could close the
/// card as dismissed while the rule still went into the settings file.
/// Only two outcomes may exist: nothing written and dismissed, or the rule
/// written and the card closed as that allow.
#[test]
fn a_dismiss_racing_an_allow_ends_in_one_of_two_consistent_states() {
    const RULE: &str = "Bash(git push origin main)";
    let (mut allowed, mut dismissed) = (0, 0);
    for round in 0..40 {
        let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
        let project = temp_dir("judged-race");
        remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
        let card = judged_card(&chat, &format!("toolu_race{round}"), "git push origin main");
        let settings = project.join(".claude").join("settings.local.json");
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let allow = {
            let (id, start) = (card.id.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                // Staggered, so both sides win some rounds.
                std::thread::sleep(std::time::Duration::from_micros((round % 8) * 40));
                allow_judged(&id, crate::claude_allow::Scope::Project)
            })
        };
        start.wait();
        // A new person turn supersedes through the same close as dismiss.
        if round % 2 == 0 {
            dismiss(&card.id);
        } else {
            forget_chat(&chat);
        }
        let result = allow.join().unwrap();
        assert!(cards_in(&chat).is_empty(), "round {round}: the card closed");
        match result {
            Ok(_) => {
                allowed += 1;
                assert!(allowed_in(&settings, RULE), "round {round}");
                assert_eq!(decision(&card.id), Some("allowed_project"), "round {round}");
            }
            Err(err) => {
                dismissed += 1;
                assert!(err.contains("no longer pending"), "round {round}: {err}");
                assert!(!allowed_in(&settings, RULE), "round {round}");
                let closed = if round % 2 == 0 {
                    "dismissed"
                } else {
                    "superseded"
                };
                assert_eq!(decision(&card.id), Some(closed), "round {round}");
            }
        }
        fs::remove_dir_all(project).unwrap();
    }
    assert_eq!(allowed + dismissed, 40);
}

/// The same two orders, forced: a close asked for mid-write waits for the
/// write, and a write after the close writes nothing.
#[test]
fn a_close_during_the_write_waits_for_it_and_one_before_it_writes_nothing() {
    use crate::claude_allow::Scope;
    let project = temp_dir("judged-order");
    let settings = project.join(".claude").join("settings.local.json");

    // Dismissed first: the allow finds no card and writes nothing.
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    let card = judged_card(&chat, "toolu_o1", "git push origin main");
    assert!(dismiss(&card.id));
    let err = allow_judged(&card.id, Scope::Project).unwrap_err();
    assert!(err.contains("Nothing was written"), "{err}");
    assert!(!settings.exists());
    assert_eq!(decision(&card.id), Some("dismissed"));

    // Claimed first: dismiss, a superseding turn and a second allow all
    // leave the card to the write in flight.
    let card = judged_card(&chat, "toolu_o2", "git push origin main");
    claim_write(&card.id, is_judged).unwrap();
    assert!(dismiss(&card.id), "the dismiss is taken, and held");
    forget_chat(&chat);
    let _: Result<(), String> = person_turn(&chat, None, || Ok(()));
    assert!(allow_judged(&card.id, Scope::Project)
        .unwrap_err()
        .contains("already being written"));
    assert_eq!(
        cards_in(&chat).len(),
        1,
        "still up while the rule is written"
    );
    assert_eq!(decision(&card.id), None);
    finish_write(&card.id, Scope::Project, true);
    assert!(cards_in(&chat).is_empty());
    assert_eq!(decision(&card.id), Some("allowed_project"));

    // A write that fails with a close held closes as the person asked.
    let card = judged_card(&chat, "toolu_o3", "git push origin main");
    claim_write(&card.id, is_judged).unwrap();
    assert!(dismiss(&card.id));
    finish_write(&card.id, Scope::Project, false);
    assert!(cards_in(&chat).is_empty());
    assert_eq!(decision(&card.id), Some("dismissed"));

    // A rule written earlier still decides a later dismiss.
    let card = judged_card(&chat, "toolu_o4", "git status --short");
    allow_judged(&card.id, Scope::Project).unwrap();
    assert!(dismiss(&card.id));
    assert_eq!(decision(&card.id), Some("allowed_project"));
    fs::remove_dir_all(project).unwrap();
}

/// A write that fails releases the claim and leaves the card pending, to
/// be allowed again or dismissed.
#[test]
fn a_failed_write_leaves_the_card_pending_and_unclaimed() {
    use crate::claude_allow::Scope;
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("judged-fail");
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    let card = judged_card(&chat, "toolu_f1", "git push origin main");
    let settings = project.join(".claude").join("settings.local.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(&settings, "not json").unwrap();
    assert!(allow_judged(&card.id, Scope::Project).is_err());
    assert_eq!(fs::read_to_string(&settings).unwrap(), "not json");
    let still = cards_in(&chat);
    assert_eq!(still.len(), 1);
    assert!(!still[0].writing && still[0].written.is_none());
    assert_eq!(decision(&card.id), None);
    // Released: a fixed file takes the next allow.
    fs::remove_file(&settings).unwrap();
    allow_judged(&card.id, Scope::Project).unwrap();
    assert!(allowed_in(&settings, "Bash(git push origin main)"));
    forget_chat(&chat);
    assert_eq!(decision(&card.id), Some("allowed_project"));
    fs::remove_dir_all(project).unwrap();
}

/// The outage card's allow goes through the same claim.
#[test]
fn an_outage_allow_holds_its_card_the_same_way() {
    use crate::claude_allow::Scope;
    let chat = format!("chat:test-{}", uuid::Uuid::new_v4());
    let project = temp_dir("outage-claim");
    remember_claude_launch(&chat, true, project.to_str().unwrap(), false, None);
    assert!(observe_claude_denial_at(
        &chat,
        &outage_denial("toolu_oc"),
        Some(("Bash", &bash("git push origin main"))),
        now_ms()
    ));
    let card = cards_in(&chat).pop().unwrap();
    claim_write(&card.id, is_outage).unwrap();
    assert!(allow_outage(&card.id, Scope::Project).is_err());
    assert!(
        retry_outage(&card.id).unwrap(),
        "the retry is taken, and held"
    );
    assert_eq!(cards_in(&chat).len(), 1);
    finish_write(&card.id, Scope::Project, true);
    assert!(cards_in(&chat).is_empty());
    assert_eq!(decision(&card.id), Some("allowed_project"));
    // Closed: a later allow writes nothing.
    assert!(allow_outage(&card.id, Scope::Project).is_err());
    assert!(!project.join(".claude").exists());
    fs::remove_dir_all(project).unwrap();
}
