use super::*;

fn draft(name: &str, project: Option<&str>) -> TeamDraft {
    TeamDraft {
        id: None,
        name: name.into(),
        role: "builds things".into(),
        agent: ChatAgent::Claude,
        model: "sonnet".into(),
        effort: Some("high".into()),
        access: None,
        project_id: project.map(Into::into),
        reports_to: None,
        avatar: None,
        team_id: None,
        persistent_prompt: None,
        desktop_tools: None,
        worker_servers: None,
    }
}

fn under(name: &str, project: Option<&str>, manager: &TeamAgent) -> TeamDraft {
    TeamDraft {
        reports_to: Some(manager.id.clone()),
        ..draft(name, project)
    }
}

fn team_draft(name: &str, project: Option<&str>) -> AgentTeamDraft {
    AgentTeamDraft {
        id: None,
        name: name.into(),
        project_id: project.map(Into::into),
    }
}

fn on(team: &AgentTeam, name: &str, project: Option<&str>) -> TeamDraft {
    TeamDraft {
        team_id: Some(team.id.clone()),
        ..draft(name, project)
    }
}

fn agent_named(path: &Path, name: &str) -> TeamAgent {
    list(path, None, true)
        .unwrap()
        .into_iter()
        .find(|a| a.name == name)
        .unwrap()
}

#[test]
fn dismissing_a_desk_offer_persists_and_keeps_its_identity() {
    let dir = crate::test_dir::TestDir::new("desk-dismiss");
    let path = dir.join("team.json");
    let mut stored = Stored::default();
    record_front_desk_chat(&mut stored, "chat:desk", "desk", "Resume roadmap");
    write(&path, &stored).unwrap();
    assert_eq!(continuable_front_desk_chats(&path).unwrap().len(), 1);
    dismiss_desk_chat(&path, "chat:desk").unwrap();
    dismiss_desk_chat(&path, "chat:desk").unwrap();
    assert!(continuable_front_desk_chats(&path).unwrap().is_empty());
    assert_eq!(front_desk_chats(&path).len(), 1);
    assert!(dismiss_desk_chat(&path, "chat:other").is_err());
}

fn codex_draft(name: &str) -> TeamDraft {
    TeamDraft {
        agent: ChatAgent::Codex,
        model: "gpt-5.6-terra".into(),
        ..draft(name, None)
    }
}

#[test]
fn desktop_tools_start_off_and_change_only_when_the_draft_says() {
    let path = temp();
    let made = save(&path, codex_draft("Social")).unwrap();
    assert!(!made.desktop_tools, "default off");
    // Not written for an agent that has it off: older files read the same.
    assert!(!std::fs::read_to_string(&*path)
        .unwrap()
        .contains("desktopTools"));
    let on = save(
        &path,
        TeamDraft {
            id: Some(made.id.clone()),
            desktop_tools: Some(true),
            ..codex_draft("Social")
        },
    )
    .unwrap();
    assert!(on.desktop_tools);
    assert!(std::fs::read_to_string(&*path)
        .unwrap()
        .contains("\"desktopTools\": true"));
    // Absent keeps it, as the avatar and the prompt are kept.
    let kept = save(
        &path,
        TeamDraft {
            id: Some(made.id.clone()),
            role: "changed".into(),
            ..codex_draft("Social")
        },
    )
    .unwrap();
    assert!(kept.desktop_tools && kept.role == "changed");
    let off = save(
        &path,
        TeamDraft {
            id: Some(made.id.clone()),
            desktop_tools: Some(false),
            ..codex_draft("Social")
        },
    )
    .unwrap();
    assert!(!off.desktop_tools);
}

#[test]
fn desktop_tools_are_for_a_codex_agent_only_and_end_when_it_leaves_codex() {
    let path = temp();
    let refused = save(
        &path,
        TeamDraft {
            desktop_tools: Some(true),
            ..draft("Claude one", None)
        },
    )
    .unwrap_err();
    assert!(
        refused.contains("only available to a Codex agent"),
        "{refused}"
    );
    let made = save(
        &path,
        TeamDraft {
            desktop_tools: Some(true),
            ..codex_draft("Social")
        },
    )
    .unwrap();
    assert!(made.desktop_tools);
    let moved = save(
        &path,
        TeamDraft {
            id: Some(made.id),
            ..draft("Social", None)
        },
    )
    .unwrap();
    assert!(!moved.desktop_tools, "a Claude agent has nothing to keep");
}

fn with_servers(names: &[&str]) -> TeamDraft {
    TeamDraft {
        worker_servers: Some(names.iter().map(|n| n.to_string()).collect()),
        ..draft("Maker", None)
    }
}

#[test]
fn worker_servers_are_checked_at_their_bounds() {
    let path = temp();
    let names: Vec<String> = (1..=13).map(|n| format!("server-{n}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    // Twelve is the most; the thirteenth is refused, and nothing is saved.
    let twelve = check(&path, with_servers(&names[..12])).unwrap();
    assert_eq!(twelve.worker_servers.len(), 12);
    let refused = check(&path, with_servers(&names)).unwrap_err();
    assert!(refused.contains("at most 12"), "{refused}");
    // A repeat is dropped before counting, the first kept.
    let mut repeated = names[..12].to_vec();
    repeated.insert(3, "server-1");
    let kept = check(&path, with_servers(&repeated)).unwrap();
    assert_eq!(kept.worker_servers, &names[..12]);
    // Each name is trimmed and 1 to 64 characters of letters, digits,
    // spaces, dots, dashes and underscores.
    let sixty_four = "a".repeat(64);
    let ok = check(
        &path,
        with_servers(&[
            " higgsfield ",
            "claude.ai Gmail",
            "mssql_pandahrms",
            &sixty_four,
        ]),
    )
    .unwrap();
    assert_eq!(
        ok.worker_servers,
        [
            "higgsfield",
            "claude.ai Gmail",
            "mssql_pandahrms",
            sixty_four.as_str()
        ]
    );
    let sixty_five = "a".repeat(65);
    for bad in [sixty_five.as_str(), "a/b", "a,b", "é", "a\tb", "x;y"] {
        let refused = check(&path, with_servers(&[bad])).unwrap_err();
        assert!(
            refused.contains("not an MCP server name"),
            "{bad:?}: {refused}"
        );
    }
    assert!(check(&path, with_servers(&["  "]))
        .unwrap_err()
        .contains("cannot be empty"));
    // OctiqFlow's own server and the host's browser copy, in any case.
    for own in ["octiq", "OCTIQ", "octiq_playwright", "Octiq_Playwright"] {
        let refused = check(&path, with_servers(&[own])).unwrap_err();
        assert!(
            refused.contains("OctiqFlow's own server"),
            "{own}: {refused}"
        );
    }
    // Absent keeps a saved list, `[]` clears it, and an empty list is not
    // written (older files read the same).
    let made = save(&path, with_servers(&["higgsfield", "sume"])).unwrap();
    let kept = save(
        &path,
        TeamDraft {
            id: Some(made.id.clone()),
            role: "changed".into(),
            ..draft("Maker", None)
        },
    )
    .unwrap();
    assert_eq!(kept.worker_servers, ["higgsfield", "sume"]);
    assert!(std::fs::read_to_string(&*path)
        .unwrap()
        .contains("\"workerServers\""));
    let cleared = save(
        &path,
        TeamDraft {
            id: Some(made.id),
            ..with_servers(&[])
        },
    )
    .unwrap();
    assert!(cleared.worker_servers.is_empty());
    assert!(!std::fs::read_to_string(&*path)
        .unwrap()
        .contains("workerServers"));
}

#[test]
fn worker_servers_are_for_claude_and_codex_and_end_when_the_agent_leaves_them() {
    let path = temp();
    let pi = |servers: Option<Vec<String>>| TeamDraft {
        agent: ChatAgent::Pi,
        model: "anthropic/claude-sonnet-5-5".into(),
        worker_servers: servers,
        ..draft("Maker", None)
    };
    let refused = save(&path, pi(Some(vec!["higgsfield".into()]))).unwrap_err();
    assert!(
        refused.contains("only available to a Claude or Codex agent"),
        "{refused}"
    );
    let codex = save(
        &path,
        TeamDraft {
            worker_servers: Some(vec!["sume".into()]),
            ..codex_draft("Maker")
        },
    )
    .unwrap();
    assert_eq!(codex.worker_servers, ["sume"]);
    // Moving to Claude keeps it; moving on to Pi ends it.
    let claude = save(
        &path,
        TeamDraft {
            id: Some(codex.id.clone()),
            ..draft("Maker", None)
        },
    )
    .unwrap();
    assert_eq!(claude.worker_servers, ["sume"]);
    let moved = save(
        &path,
        TeamDraft {
            id: Some(codex.id),
            ..pi(None)
        },
    )
    .unwrap();
    assert!(moved.worker_servers.is_empty());
}

#[test]
fn teams_are_created_renamed_and_named_uniquely_where_they_overlap() {
    let path = temp();
    let web = save_team(&path, team_draft(" Web ", None)).unwrap();
    assert_eq!(web.name, "Web");
    assert!(web.id.starts_with("team_"));
    assert!(save_team(&path, team_draft("", None)).is_err());
    assert!(save_team(&path, team_draft(&"x".repeat(61), None)).is_err());
    // A global name is seen everywhere, so a project team cannot reuse it.
    assert_eq!(
        save_team(&path, team_draft("web", Some("p1"))).unwrap_err(),
        "Another team is already called web."
    );
    let p1 = save_team(&path, team_draft("Data", Some("p1"))).unwrap();
    // Two projects' teams never meet, so they may share a name.
    save_team(&path, team_draft("Data", Some("p2"))).unwrap();
    let renamed = save_team(
        &path,
        AgentTeamDraft {
            id: Some(web.id.clone()),
            ..team_draft("Frontend", None)
        },
    )
    .unwrap();
    assert_eq!(
        (renamed.id.as_str(), renamed.name.as_str()),
        (web.id.as_str(), "Frontend")
    );
    assert_eq!(renamed.created_at, web.created_at);
    assert_eq!(teams(&path).unwrap().len(), 3);
    assert!(save_team(
        &path,
        AgentTeamDraft {
            id: Some("team_gone".into()),
            ..team_draft("Ghost", None)
        }
    )
    .is_err());
    // The team store survives the agents' own writes.
    save(&path, on(&p1, "Ada", Some("p1"))).unwrap();
    assert_eq!(teams(&path).unwrap().len(), 3);
}

#[test]
fn membership_follows_project_scope() {
    let path = temp();
    let global = save_team(&path, team_draft("Global", None)).unwrap();
    let p1 = save_team(&path, team_draft("P1", Some("p1"))).unwrap();
    // Global agents join any team; project agents only global teams and
    // their own project's.
    assert_eq!(
        save(&path, on(&p1, "Ada", None)).unwrap().team_id,
        Some(p1.id.clone())
    );
    assert!(save(&path, on(&p1, "Bo", Some("p1"))).is_ok());
    assert!(save(&path, on(&global, "Cy", Some("p2"))).is_ok());
    assert_eq!(
        save(&path, on(&p1, "Di", Some("p2"))).unwrap_err(),
        "Di cannot be on P1: that team belongs to another project."
    );
    assert_eq!(
        save(
            &path,
            on(
                &AgentTeam {
                    id: "team_gone".into(),
                    ..p1.clone()
                },
                "Ed",
                None
            )
        )
        .unwrap_err(),
        "The chosen team no longer exists."
    );
    // Moving a member into another project while on a project team is
    // refused; so is narrowing a team past one of its members.
    let bo = agent_named(&path, "Bo");
    assert!(save(
        &path,
        TeamDraft {
            id: Some(bo.id.clone()),
            ..draft("Bo", Some("p2"))
        }
    )
    .is_err());
    assert!(save_team(
        &path,
        AgentTeamDraft {
            id: Some(global.id.clone()),
            ..team_draft("Global", Some("p1"))
        }
    )
    .unwrap_err()
    .starts_with("Cy is on this team"));
}

#[test]
fn an_edit_that_says_nothing_about_the_team_keeps_it_and_empty_clears_it() {
    let path = temp();
    let web = save_team(&path, team_draft("Web", None)).unwrap();
    let ada = save(&path, on(&web, "Ada", None)).unwrap();
    let kept = save(
        &path,
        TeamDraft {
            id: Some(ada.id.clone()),
            model: "opus".into(),
            ..draft("Ada", None)
        },
    )
    .unwrap();
    assert_eq!(kept.team_id.as_deref(), Some(web.id.as_str()));
    let cleared = save(
        &path,
        TeamDraft {
            id: Some(ada.id.clone()),
            team_id: Some(String::new()),
            ..draft("Ada", None)
        },
    )
    .unwrap();
    assert_eq!(cleared.team_id, None);
}

#[test]
fn removing_a_team_or_an_agent_ends_the_membership_and_nothing_else() {
    let path = temp();
    let web = save_team(&path, team_draft("Web", None)).unwrap();
    let ada = save(&path, on(&web, "Ada", None)).unwrap();
    let bo = save(
        &path,
        TeamDraft {
            reports_to: Some(ada.id.clone()),
            ..on(&web, "Bo", None)
        },
    )
    .unwrap();
    let cy = save(&path, on(&web, "Cy", None)).unwrap();
    let everyone = list(&path, None, true).unwrap();
    let teams_now = teams(&path).unwrap();
    let names = |me: &TeamAgent, all: &[TeamAgent], t: &[AgentTeam]| {
        teammates(all, t, me)
            .into_iter()
            .map(|a| a.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&ada, &everyone, &teams_now), ["Bo", "Cy"]);
    delete(&path, &cy.id).unwrap();
    let everyone = list(&path, None, true).unwrap();
    assert_eq!(names(&ada, &everyone, &teams_now), ["Bo"]);
    delete_team(&path, &web.id).unwrap();
    assert!(teams(&path).unwrap().is_empty());
    let everyone = list(&path, None, true).unwrap();
    assert!(everyone.iter().all(|a| a.team_id.is_none()));
    // The org chart is untouched by either.
    assert_eq!(
        agent_named(&path, "Bo").reports_to.as_deref(),
        Some(ada.id.as_str())
    );
    assert_eq!(bo.reports_to.as_deref(), Some(ada.id.as_str()));
    assert!(delete_team(&path, &web.id).is_err());
}

#[test]
fn a_workers_peer_brief_lists_teammates_who_may_look_at_its_project() {
    let path = temp();
    let web = save_team(&path, team_draft("Web", None)).unwrap();
    let ada = save(&path, on(&web, "Ada", None)).unwrap();
    save(&path, on(&web, "Bo", Some("p1"))).unwrap();
    save(&path, on(&web, "Cy", Some("p2"))).unwrap();
    save(&path, draft("Di", None)).unwrap();
    let everyone = list(&path, None, true).unwrap();
    let all_teams = teams(&path).unwrap();
    let brief = peer_brief(&everyone, &all_teams, &ada, "p1", true).unwrap();
    assert!(brief.contains("You are on the team Web."));
    assert!(brief.contains("Bo — builds things"));
    assert!(brief.contains(&format!("id `{}`", agent_named(&path, "Bo").id)));
    assert!(brief.contains("Peers answer questions; they do not do the work."));
    assert!(brief.contains("orchestration_peer_ask"));
    // Not itself, not someone off the team, not a teammate who cannot
    // look at this project.
    assert!(!brief.contains("Ada —"));
    assert!(!brief.contains("Di —"));
    assert!(!brief.contains("Cy —"));
    // No brief at all without anyone to ask.
    let di = agent_named(&path, "Di");
    assert!(peer_brief(&everyone, &all_teams, &di, "p1", true).is_none());
    let cy = agent_named(&path, "Cy");
    assert!(peer_brief(&everyone, &all_teams, &cy, "p2", true)
        .unwrap()
        .contains("Ada —"));
    // Work is the other tool, with its own bounds; the worker of a peer
    // request is told how to ask and never how to hand work on.
    assert!(brief.contains("Work is orchestration_peer_request"));
    assert!(brief.contains("nothing starts until the person approves it"));
    assert!(brief.contains("At most 2 per attempt"));
    assert!(brief.contains("It changes nobody's manager."));
    let asks_only = peer_brief(&everyone, &all_teams, &ada, "p1", false).unwrap();
    assert!(asks_only.contains("orchestration_peer_ask"));
    assert!(!asks_only.contains("orchestration_peer_request"));
}

#[test]
fn a_lead_is_told_who_its_peers_are_in_its_first_brief_and_on_later_turns() {
    let path = temp();
    let leads = save_team(&path, team_draft("Leads", None)).unwrap();
    let ada = save(&path, on(&leads, "Ada", None)).unwrap();
    let bo = save(&path, on(&leads, "Bo", Some("p2"))).unwrap();
    let cy = save(&path, draft("Cy", None)).unwrap();
    let everyone = list(&path, None, true).unwrap();
    let all_teams = teams(&path).unwrap();
    let peers = lead_peer_brief(&everyone, &all_teams, &ada).unwrap();
    assert!(peers.starts_with("You are on the team Leads. These are your peers, not your reports"));
    // Every teammate, wherever it works: a request goes to its project.
    assert!(peers.contains(&format!("id `{}` · Bo —", bo.id)), "{peers}");
    assert!(!peers.contains("Cy —") && !peers.contains("Ada —"));
    assert!(peers.contains("orchestration_peer_ask"));
    assert!(peers.contains("At most 5 asks from this chat in any hour"));
    assert!(peers.contains("Work is orchestration_peer_request"));
    assert!(peers.contains("At most 3 open at once from this chat"));
    assert!(peers.contains("orchestration_task_create still takes only your direct reports"));
    // Alone on its team, or on none, there is nothing to say.
    assert!(lead_peer_brief(&everyone, &all_teams, &cy).is_none());
    assert!(lead_peer_brief(&everyone[..1], &all_teams, &ada).is_none());

    // The first brief of a lead's chat carries it, and so does a later
    // turn's roster, so a chat older than the team still learns of it.
    let first = brief(
        &path,
        "chat:ada",
        "p1",
        &ada.id,
        "Check the NAS",
        false,
        &[],
    )
    .unwrap();
    assert!(first.contains("You are on the team Leads."), "{first}");
    confirm_turn_brief(&path, "chat:ada", &first).unwrap();
    let later = refresh_turn_brief(&path, "chat:ada", "And now?".into(), &[]).unwrap();
    assert_eq!(later, "And now?");
    let no_team = brief(&path, "chat:cy", "p1", &cy.id, "Check the NAS", false, &[]).unwrap();
    assert!(!no_team.contains("orchestration_peer_request"));
    // Neither brief wrote anything about who reports to whom.
    assert_eq!(agent_named(&path, "Bo").reports_to, None);
    assert_eq!(agent_named(&path, "Ada").updated_at, ada.updated_at);
}

fn temp() -> crate::test_dir::TestPath {
    crate::test_dir::TestPath::new("team", "team.json")
}

const PNG_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

#[test]
fn an_avatar_is_checked_kept_across_edits_and_removable() {
    let path = temp();
    let bad = save(
        &path,
        TeamDraft {
            avatar: Some("data:image/png;base64,PHN2Zz4=".into()),
            ..draft("Ada", None)
        },
    );
    assert!(bad.is_err(), "an SVG declared as PNG is refused");
    let ada = save(
        &path,
        TeamDraft {
            avatar: Some(PNG_URL.into()),
            ..draft("Ada", None)
        },
    )
    .unwrap();
    assert_eq!(ada.avatar.as_deref(), Some(PNG_URL));
    // A later edit that says nothing about the avatar keeps it, and a
    // change of model keeps the identity whole.
    let edited = save(
        &path,
        TeamDraft {
            id: Some(ada.id.clone()),
            model: "opus".into(),
            ..draft("Ada", None)
        },
    )
    .unwrap();
    assert_eq!(edited.avatar.as_deref(), Some(PNG_URL));
    assert_eq!(
        list(&path, None, true).unwrap()[0].avatar.as_deref(),
        Some(PNG_URL)
    );
    let cleared = save(
        &path,
        TeamDraft {
            id: Some(ada.id),
            avatar: Some(String::new()),
            ..draft("Ada", None)
        },
    )
    .unwrap();
    assert_eq!(cleared.avatar, None);
}

#[test]
fn the_coordination_home_is_a_configured_workspace_id() {
    let path = temp();
    assert_eq!(home(&path).unwrap(), None);
    assert_eq!(
        set_home(&path, Some(" ws-general ")).unwrap().as_deref(),
        Some("ws-general")
    );
    assert_eq!(home(&path).unwrap().as_deref(), Some("ws-general"));
    // The head and the team are untouched by it.
    save(&path, draft("Ada", None)).unwrap();
    assert_eq!(home(&path).unwrap().as_deref(), Some("ws-general"));
    assert_eq!(set_home(&path, Some("")).unwrap(), None);
}

#[test]
fn project_sees_global_and_its_own_agents_only() {
    let path = temp();
    save(&path, draft("Ada", None)).unwrap();
    save(&path, draft("Bo", Some("p1"))).unwrap();
    save(&path, draft("Cy", Some("p2"))).unwrap();
    let names = |p| {
        list(&path, Some(p), false)
            .unwrap()
            .into_iter()
            .map(|a| a.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(names("p1"), ["Ada", "Bo"]);
    assert_eq!(names("p2"), ["Ada", "Cy"]);
    assert_eq!(list(&path, None, true).unwrap().len(), 3);
}

#[test]
fn visible_names_must_be_unique() {
    let path = temp();
    save(&path, draft("Ada", None)).unwrap();
    assert!(save(&path, draft("ada", Some("p1"))).is_err());
    save(&path, draft("Bo", Some("p1"))).unwrap();
    // Different projects never see each other.
    save(&path, draft("Bo", Some("p2"))).unwrap();
    // A global Bo would collide with both.
    assert!(save(&path, draft("Bo", None)).is_err());
}

#[test]
fn edit_keeps_id_and_creation_time() {
    let path = temp();
    let first = save(&path, draft("Ada", None)).unwrap();
    let mut change = draft("Ada Lovelace", None);
    change.id = Some(first.id.clone());
    let second = save(&path, change).unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(second.created_at, first.created_at);
    assert_eq!(list(&path, None, true).unwrap().len(), 1);
    delete(&path, &first.id).unwrap();
    assert!(list(&path, None, true).unwrap().is_empty());
}

#[test]
fn chart_refuses_loops_and_managers_that_are_not_visible() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    let cto = save(&path, under("Cto", None, &ceo)).unwrap();
    // The CEO cannot report to someone who reports to it.
    let mut looped = under("Ceo", None, &cto);
    looped.id = Some(ceo.id.clone());
    assert!(save(&path, looped).unwrap_err().contains("already reports"));
    // A global agent cannot report to a project agent.
    let local = save(&path, draft("Local", Some("p1"))).unwrap();
    assert!(save(&path, under("Wide", None, &local)).is_err());
    // A project agent may report to a global one.
    save(&path, under("Dev", Some("p1"), &cto)).unwrap();
    // The CTO cannot move into p2 while a p1 agent reports to it.
    let mut moved = under("Cto", Some("p2"), &ceo);
    moved.id = Some(cto.id.clone());
    assert!(save(&path, moved).is_err());
}

#[test]
fn deleting_a_manager_moves_its_reports_up() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    let cto = save(&path, under("Cto", None, &ceo)).unwrap();
    let dev = save(&path, under("Dev", None, &cto)).unwrap();
    delete(&path, &cto.id).unwrap();
    let dev = list(&path, None, true)
        .unwrap()
        .into_iter()
        .find(|a| a.id == dev.id)
        .unwrap();
    assert_eq!(dev.reports_to.as_deref(), Some(ceo.id.as_str()));
}

/// The removal card's snapshot is the same for the same chart however the
/// agents are ordered, and `delete` with no snapshot (Settings) removes as
/// it always did, moving each report up as a new version of itself.
#[test]
fn a_removal_snapshot_ignores_order_and_a_plain_delete_needs_none() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    let cto = save(&path, under("Cto", None, &ceo)).unwrap();
    let dev = save(&path, under("Dev", None, &cto)).unwrap();
    let ops = save(&path, under("Ops", None, &cto)).unwrap();
    set_head(&path, Some(&cto.id)).unwrap();
    let agents = list(&path, None, true).unwrap();
    let shown = removal(&agents, Some(&cto.id), None, &cto.id).unwrap();
    assert_eq!(shown.updated_at, cto.updated_at);
    assert_eq!(shown.reports_to.as_deref(), Some(ceo.id.as_str()));
    assert_eq!(shown.reports.len(), 2);
    assert!(shown.head && !shown.front_desk);
    let mut reversed = agents.clone();
    reversed.reverse();
    assert_eq!(
        removal(&reversed, Some(&cto.id), None, &cto.id).unwrap(),
        shown
    );
    assert!(removal(&agents, None, None, "agent_nobody").is_none());
    // Each thing the card states is compared, not only the version.
    let moved = Removal {
        reports_to: None,
        ..shown.clone()
    };
    assert_eq!(
        shown.changed(&moved),
        Some(": it no longer reports to who the card said")
    );
    let fewer = Removal {
        reports: vec![dev.id.clone()],
        ..shown.clone()
    };
    assert_eq!(
        shown.changed(&fewer),
        Some(": its direct reports are not the ones the card listed")
    );
    assert_eq!(shown.changed(&shown), None);

    // The seat given up while a card waited: refused, nothing written.
    set_head(&path, None).unwrap();
    let idle = Asked(|_: &TeamAgent| Ok(()));
    let refused = delete_unchanged(&path, &cto.id, &shown, &idle).unwrap_err();
    assert_eq!(
            refused,
            "Cto was changed while this waited for approval, so nothing was removed: it is no longer the head. Read it again and propose the removal again."
        );
    assert_eq!(list(&path, None, true).unwrap(), agents);

    delete(&path, &cto.id).unwrap();
    let left = list(&path, None, true).unwrap();
    for moved in [&dev, &ops] {
        let after = left.iter().find(|a| a.id == moved.id).unwrap();
        assert_eq!(after.reports_to.as_deref(), Some(ceo.id.as_str()));
        assert!(after.updated_at > moved.updated_at);
    }
    assert_eq!(left.iter().find(|a| a.id == ceo.id), Some(&ceo));
}

/// agent_delete review, M3: a removal asks whether the agent is idle at
/// the moment it is made, with the roster's lock held, of the agent as
/// stored. Refused, nothing is written; the refusal is the asker's words.
#[test]
fn a_removal_is_not_made_while_the_agent_is_not_idle() {
    let path = temp();
    let lead = save(&path, draft("Lead", None)).unwrap();
    let dev = save(
        &path,
        TeamDraft {
            reports_to: Some(lead.id.clone()),
            ..draft("Dev", None)
        },
    )
    .unwrap();
    let before = list(&path, None, true).unwrap();
    let asked = std::cell::RefCell::new(Vec::new());
    let busy = Asked(|agent: &TeamAgent| {
        asked.borrow_mut().push(agent.clone());
        // The lock the removal is written under is held while this runs.
        assert!(LOCK.try_lock().is_err());
        Err(format!("{} still has 1 task in progress.", agent.name))
    });
    let shown = removal(&before, None, None, &lead.id).unwrap();
    for refused in [
        delete_idle(&path, &lead.id, &busy).unwrap_err(),
        delete_unchanged(&path, &lead.id, &shown, &busy).unwrap_err(),
    ] {
        assert_eq!(refused, "Lead still has 1 task in progress.");
    }
    assert_eq!(asked.borrow().as_slice(), [lead.clone(), lead.clone()]);
    assert_eq!(list(&path, None, true).unwrap(), before);

    // A card the chart has since left behind is refused for that, and
    // the ledger is not asked about a removal that cannot be made.
    let stale = Removal {
        reports: Vec::new(),
        ..shown.clone()
    };
    let refused = delete_unchanged(&path, &lead.id, &stale, &busy).unwrap_err();
    assert!(refused.contains("changed while this waited"), "{refused}");
    assert_eq!(asked.borrow().len(), 2);
    assert!(delete_idle(&path, "agent_nobody", &busy).is_err());
    assert_eq!(asked.borrow().len(), 2);

    // Idle: removed, and its report moves up.
    delete_idle(&path, &lead.id, &Asked(|_: &TeamAgent| Ok(()))).unwrap();
    let left = list(&path, None, true).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, dev.id);
    assert_eq!(left[0].reports_to, None);
}

/// Two saves of one agent in the same millisecond are still two versions.
#[test]
fn every_save_of_an_agent_is_a_later_version() {
    let path = temp();
    let mut last = save(&path, draft("Ada", None)).unwrap();
    for _ in 0..20 {
        let next = save(
            &path,
            TeamDraft {
                id: Some(last.id.clone()),
                ..draft("Ada", None)
            },
        )
        .unwrap();
        assert!(next.updated_at > last.updated_at);
        last = next;
    }
}

#[test]
fn fable_reports_are_assignable_and_present_in_the_manager_brief() {
    let path = temp();
    let lead = save(&path, draft("Lead", None)).unwrap();
    for model in ["fable", "claude-fable-5", "CLAUDE-FABLE-5-20260924"] {
        let mut worker = under("Fable dev", None, &lead);
        worker.model = model.into();
        let worker = save(&path, worker).unwrap();
        assert!(worker.can_work());
        assert_eq!(
            resolve(&path, "p1", &worker.id, Some(&lead.id))
                .unwrap()
                .model,
            model
        );
        let roster = list(&path, None, true).unwrap();
        assert_eq!(eligible_direct_reports(&roster, &lead.id).len(), 1);
        let text = brief(
            &path,
            "chat:fable-manager",
            "p1",
            &lead.id,
            "Do the task",
            false,
            &[],
        )
        .unwrap();
        assert!(text.contains(&format!("id `{}`", worker.id)));
        assert!(!text.contains("lead only"));
        // Remove this fixture before registering the next model spelling.
        delete_idle(&path, &worker.id, &Asked(|_: &TeamAgent| Ok(()))).unwrap();
    }
    for model in ["astra", "gpt-6-astra", "GPT-6-ASTRA-20260924"] {
        let mut worker = lead.clone();
        worker.model = model.into();
        assert!(!worker.can_work());
    }
}

#[test]
fn resolve_enforces_direct_reports_and_lead_only_models() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    let ada = save(&path, under("Ada", None, &ceo)).unwrap();
    let dev = save(&path, under("Dev", None, &ada)).unwrap();
    let mut boss = under("Boss", None, &ceo);
    boss.model = "gpt-6-astra".into();
    boss.agent = ChatAgent::Codex;
    save(&path, boss).unwrap();
    assert_eq!(
        resolve(&path, "p1", &ada.id, Some(&ceo.id)).unwrap().name,
        "Ada"
    );
    assert_eq!(
        resolve(&path, "p1", "ADA", Some(&ceo.id)).unwrap().id,
        ada.id
    );
    // Two levels down is not a direct report.
    assert!(resolve(&path, "p1", &dev.id, Some(&ceo.id))
        .unwrap_err()
        .contains("direct reports: Ada, Boss"));
    assert!(resolve(&path, "p1", "Boss", Some(&ceo.id))
        .unwrap_err()
        .contains("lead-only"));
    assert!(resolve(&path, "p1", "nobody", None).is_err());
    // Without a manager (ordinary orchestration) any agent may be named.
    assert_eq!(resolve(&path, "p1", &dev.id, None).unwrap().name, "Dev");
}

#[test]
fn registers_pi_with_a_named_upstream_and_rejects_default_models() {
    let path = temp();
    // The draft's own model is Claude's alias: a bare Claude id is not a
    // Pi model (a bare id means Codex's upstream), so it is refused.
    let mut pi = draft("Pi", None);
    pi.agent = ChatAgent::Pi;
    assert!(save(&path, pi).is_err());
    let mut api = draft("Pi API", None);
    api.agent = ChatAgent::Pi;
    api.model = "anthropic/claude-sonnet-5-5".into();
    let saved = save(&path, api).unwrap();
    assert_eq!(saved.agent, ChatAgent::Pi);
    assert_eq!(saved.model, "anthropic/claude-sonnet-5-5");
    let mut codex = draft("Pi Codex", None);
    codex.agent = ChatAgent::Pi;
    codex.model = "gpt-5.6-sol".into();
    assert!(save(&path, codex).is_ok());
    let mut default = draft("D", None);
    default.model = "default".into();
    assert!(save(&path, default).is_err());
}

#[test]
fn brief_lists_only_direct_reports_and_records_the_lead() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    let ada = save(&path, under("Ada", None, &ceo)).unwrap();
    save(&path, under("Dev", None, &ada)).unwrap();
    save(&path, draft("Zed", Some("p2"))).unwrap();
    let text = brief(
        &path,
        "chat:1",
        "p1",
        &ceo.id,
        "  Fix the login bug  ",
        false,
        &[],
    )
    .unwrap();
    let (task, rest) = text.split_once(BRIEF_MARK).unwrap();
    assert_eq!(task, "Fix the login bug");
    assert!(rest.starts_with("Lead: Ceo\n"));
    assert!(rest.contains(&format!("id `{}`", ada.id)));
    assert!(rest.contains("manages Dev"));
    assert!(rest.contains("approves your plan"));
    // Dev is Ada's report, not the lead's: only Ada is assignable.
    assert_eq!(rest.matches("id `").count(), 1);
    assert!(!rest.contains("Zed"));
    let record = lead_for_chat(&path, "chat:1").unwrap().unwrap();
    assert_eq!(record.lead_id, ceo.id);
}

#[test]
fn a_lead_with_no_reports_does_it_itself() {
    let path = temp();
    let solo = save(&path, draft("Solo", None)).unwrap();
    let text = brief(
        &path,
        "chat:2",
        "p1",
        &solo.id,
        "Tidy the README",
        false,
        &[],
    )
    .unwrap();
    assert!(text.contains("do the task yourself"));
    assert!(!text.contains("orchestration_task_create"));

    let mut lead_only = under("Lead only", None, &solo);
    lead_only.model = "gpt-6-astra".into();
    lead_only.agent = ChatAgent::Codex;
    let lead_only = save(&path, lead_only).unwrap();
    let text = brief(
        &path,
        "chat:solo-with-lead-only-report",
        "p1",
        &solo.id,
        "Tidy it again",
        false,
        &[],
    )
    .unwrap();
    assert!(text.contains("No eligible agent currently reports to you"));
    assert!(!text.contains(&format!("id `{}`", lead_only.id)));
}

#[test]
fn manager_brief_only_for_agents_with_reports() {
    let path = temp();
    let ada = save(&path, draft("Ada", None)).unwrap();
    let dev = save(&path, under("Dev", None, &ada)).unwrap();
    let text = manager_brief(&path, "p1", &ada.id, "task_1", "run_1")
        .unwrap()
        .unwrap();
    assert!(text.contains("parentTaskId 'task_1'"));
    assert!(text.contains(&dev.id));
    assert!(manager_brief(&path, "p1", &dev.id, "task_2", "run_1")
        .unwrap()
        .is_none());
}

#[test]
fn every_agent_gets_one_stable_memory_note() {
    let path = temp();
    let ryan = save(&path, draft("Ryan Lee", None)).unwrap();
    assert_eq!(
        ryan.memory_note.as_deref(),
        Some("agent-zone/agents/ryan-lee/memory.md")
    );
    // Two agents in different projects may share a name, not a note.
    let one = save(&path, draft("Kai", Some("p1"))).unwrap();
    let two = save(&path, draft("Kai", Some("p2"))).unwrap();
    assert_ne!(one.memory_note, two.memory_note);
    // A rename keeps what the agent remembers.
    let mut renamed = draft("Ryan", None);
    renamed.id = Some(ryan.id.clone());
    let renamed = save(&path, renamed).unwrap();
    assert_eq!(renamed.memory_note, ryan.memory_note);
}

#[test]
fn dates_are_civil_utc() {
    assert_eq!(utc_date(0), "1970-01-01");
    assert_eq!(utc_date(951_782_400_000), "2000-02-29");
    assert_eq!(utc_date(1_790_294_400_000), "2026-09-25");
}

/// The offset each checked zone has on 2026-09-28/29.
const PROBE_ZONES: [(&str, i32); 4] = [
    ("UTC", 0),
    ("Asia/Kuala_Lumpur", 8 * 3600),
    ("Pacific/Kiritimati", 14 * 3600),
    ("America/Los_Angeles", -7 * 3600),
];

#[test]
fn a_local_date_turns_at_local_midnight_not_utc_midnight() {
    // 2026-09-29T00:00:00Z.
    let utc_midnight = 1_790_640_000_000_i64;
    for (zone, offset_secs) in PROBE_ZONES {
        let midnight = utc_midnight - i64::from(offset_secs) * 1000;
        let at = |ms| LocalNow { ms, offset_secs };
        assert_eq!(at(midnight - 1).date(), "2026-09-28", "{zone}");
        assert_eq!(at(midnight).date(), "2026-09-29", "{zone}");
    }
}

/// Runs this same test binary under each real zone name, so the OS's own
/// zone database — not a number typed here — gives the offset and the date.
#[cfg(unix)]
#[test]
fn this_machines_zone_decides_the_local_date() {
    let utc_midnight = 1_790_640_000_000_i64;
    if let Ok(zone) = std::env::var("OCTIQ_TZ_PROBE") {
        let (_, offset) = PROBE_ZONES.iter().find(|(z, _)| *z == zone).unwrap();
        let midnight = utc_midnight - i64::from(*offset) * 1000;
        assert_eq!(LocalNow::at(midnight).offset_secs, *offset, "{zone}");
        assert_eq!(
            LocalNow::at(midnight - 30_000).date(),
            "2026-09-28",
            "{zone}"
        );
        assert_eq!(
            LocalNow::at(midnight + 30_000).date(),
            "2026-09-29",
            "{zone}"
        );
        return;
    }
    for (zone, _) in PROBE_ZONES {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "team::tests::this_machines_zone_decides_the_local_date",
                "--test-threads=1",
            ])
            .env("TZ", zone)
            .env("OCTIQ_TZ_PROBE", zone)
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{zone}: {said}");
        assert!(said.contains("1 passed"), "{zone} ran nothing: {said}");
    }
}

#[test]
fn identity_comes_from_the_chat_and_reads_stop_at_direct_reports() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    let ada = save(&path, under("Ada", None, &ceo)).unwrap();
    let dev = save(&path, under("Dev", None, &ada)).unwrap();
    brief(&path, "chat:lead", "p1", &ceo.id, "Do it", false, &[]).unwrap();
    assert_eq!(identity(&path, "chat:lead", None).unwrap().0.id, ceo.id);
    assert_eq!(
        identity(&path, "chat:worker", Some(dev.id.clone()))
            .unwrap()
            .0
            .id,
        dev.id
    );
    assert!(identity(&path, "chat:stranger", None).is_err());

    let (me, team) = identity(&path, "chat:lead", None).unwrap();
    let vault = crate::memory_vault::Vault::profile();
    // Two levels down is not a direct report; refused before the vault.
    assert!(
        memory_read(&vault, "chat:lead", &me, &team, Some("Dev"), None)
            .unwrap_err()
            .contains("does not report to you")
    );
}

#[test]
fn an_empty_memory_entry_names_the_text_field_before_touching_the_vault() {
    let base = crate::test_dir::TestDir::new("empty-memory");
    let profile = base.join("profile");
    let vault = crate::memory_vault::Vault::at(profile.clone());
    let path = temp();
    let nova = save(&path, draft("Nova", None)).unwrap();
    for text in ["", " \n\t"] {
        let append = memory_append(&vault, "chat:lead", &nova, text, None, "empty");
        assert_eq!(
            append.result(&nova).unwrap_err(),
            "Pass the entry as `text` (1–4000 characters); nothing was written."
        );
        assert!(append.note.is_none());
        assert!(!profile.exists(), "validation must not write to the vault");
    }
}

#[test]
fn a_memory_read_loads_the_newest_entries_and_startline_still_pages_the_note() {
    // A 962-line note used to load as its first 200 lines: its oldest.
    let base = crate::test_dir::TestDir::new("memory");
    let root = base.join("vault");
    std::fs::create_dir_all(&root).unwrap();
    let vault = crate::memory_vault::Vault::at(base.join("profile"));
    vault
        .configure(crate::memory_vault::Config {
            path: root.to_string_lossy().into_owned(),
            writable: true,
        })
        .unwrap();
    let path = temp();
    let nova = save(&path, draft("Nova", None)).unwrap();
    let team = list(&path, None, true).unwrap();
    for day in 1..=28 {
        let text = format!("Lesson {day}.\n{}", "detail\n".repeat(20));
        memory_append(
            &vault,
            "chat:lead",
            &nova,
            &text,
            Some(&format!("2026-09-{day:02}")),
            &format!("r{day}"),
        )
        .result(&nova)
        .unwrap();
    }

    let loaded = memory_read(&vault, "chat:lead", &nova, &team, None, None).unwrap();
    let content = loaded["content"].as_str().unwrap();
    assert!(content.contains("Lesson 28."), "the newest entry is loaded");
    assert!(!content.contains("Lesson 1.\n"), "the oldest is left out");
    assert!(content.contains("# Nova — memory"));
    assert_eq!(loaded["entries"], 28);
    assert_eq!(loaded["hasLessons"], false);
    assert!(loaded["olderEntriesFrom"].as_u64().is_some());
    assert!(loaded["lessonsHint"].is_string());
    assert!(loaded["revision"].is_string() && loaded["totalLines"].as_u64() > Some(600));
    assert_eq!(loaded["agent"], "Nova");

    let from = loaded["olderEntriesFrom"].as_u64().unwrap();
    let page = memory_read(&vault, "chat:lead", &nova, &team, None, Some(from)).unwrap();
    assert!(page["content"]
        .as_str()
        .unwrap()
        .starts_with("## 2026-09-01\n\nLesson 1."));
}

#[test]
fn a_renamed_agents_memory_header_names_it_and_its_history_is_untouched() {
    // Feedback 10cc5a23: after Settings renamed Maya to Mango Juice, the
    // note still read "agent: Maya" and "# Maya — memory".
    let base = crate::test_dir::TestDir::new("memory");
    let root = base.join("vault");
    std::fs::create_dir_all(&root).unwrap();
    let vault = crate::memory_vault::Vault::at(base.join("profile"));
    vault
        .configure(crate::memory_vault::Config {
            path: root.to_string_lossy().into_owned(),
            writable: true,
        })
        .unwrap();
    let path = temp();
    let maya = save(&path, draft("Maya", None)).unwrap();
    ensure_memory(&vault, "octiq:team", &maya).unwrap();
    memory_append(
        &vault,
        "chat:lead",
        &maya,
        "Maya decided X.",
        Some("2026-09-25"),
        "r1",
    )
    .result(&maya)
    .unwrap();

    let mut renamed = draft("Mango Juice", None);
    renamed.id = Some(maya.id.clone());
    let mango = save(&path, renamed).unwrap();
    assert_eq!(
        mango.memory_note, maya.memory_note,
        "the note path is fixed"
    );
    ensure_memory(&vault, "octiq:team", &mango).unwrap();
    // Idempotent: a second save changes nothing.
    ensure_memory(&vault, "octiq:team", &mango).unwrap();

    let text = std::fs::read_to_string(root.join(mango.memory_note.as_ref().unwrap())).unwrap();
    assert!(text.contains("agent: Mango Juice\n"), "{text}");
    assert!(text.contains("# Mango Juice — memory\n"), "{text}");
    assert!(
        text.contains("Working memory for Mango Juice, a registered OctiqFlow agent."),
        "{text}"
    );
    assert!(text.contains(&format!("agent-id: {}", maya.id)));
    assert!(text.contains("Maya decided X."), "history is kept: {text}");
    assert!(!text.contains("agent: Maya\n"), "{text}");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn only_the_seeded_header_is_ever_relabelled() {
    let seeded = memory_seed(&TeamAgent {
        name: "Ryan".into(),
        ..save(&temp(), draft("Ryan", None)).unwrap()
    });
    let (old, new) = relabel_memory_header(&seeded, "Potato Juice").unwrap();
    assert!(seeded.starts_with(&old));
    assert!(new.contains("agent: Potato Juice") && new.contains("# Potato Juice — memory"));
    assert!(
        relabel_memory_header(&seeded, "Ryan").is_none(),
        "already right"
    );
    // A note OctiqFlow did not seed is left alone.
    assert!(relabel_memory_header("# My notes\n\nagent: Ryan", "Potato").is_none());
    // Nothing past the first dated entry is looked at.
    let later = format!("{seeded}\n## 2026-09-25\n\n# Ryan — memory\n");
    let (old, _) = relabel_memory_header(&later, "Potato").unwrap();
    assert!(!old.contains("## 2026-09-25"));
}

#[test]
fn briefs_carry_the_memory_instructions() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    save(&path, under("Ada", None, &ceo)).unwrap();
    let text = brief(&path, "chat:1", "p1", &ceo.id, "Ship it", false, &[]).unwrap();
    assert!(text.contains("vault_agent_memory_read"));
    assert!(text.contains("direct reports' memories"));
    assert!(text.contains("Ada"));
}

#[test]
fn the_head_is_one_configured_global_agent() {
    let path = temp();
    assert!(head(&path).unwrap().is_none());
    let ryan = save(&path, draft("Ryan", None)).unwrap();
    let local = save(&path, draft("Local", Some("p1"))).unwrap();
    assert!(set_head(&path, Some(&local.id))
        .unwrap_err()
        .contains("every project"));
    set_head(&path, Some(&ryan.id)).unwrap();
    assert_eq!(head(&path).unwrap().unwrap().id, ryan.id);
    // The head cannot quietly become a project agent.
    let mut moved = draft("Ryan", Some("p1"));
    moved.id = Some(ryan.id.clone());
    assert!(save(&path, moved).unwrap_err().contains("stays global"));
    // Removing it leaves no head rather than a dangling one.
    delete(&path, &ryan.id).unwrap();
    assert!(head(&path).unwrap().is_none());
    assert!(set_head(&path, None).unwrap().is_none());
}

#[test]
fn the_head_brief_spans_projects_and_asks_for_destinations() {
    let path = temp();
    let ryan = save(&path, draft("Ryan", None)).unwrap();
    let maya = save(&path, under("Maya", None, &ryan)).unwrap();
    let sam = save(&path, under("Sam", Some("p2"), &ryan)).unwrap();
    save(&path, draft("Zed", Some("p3"))).unwrap();
    let projects = [
        ("p1".to_owned(), "General".to_owned()),
        ("p2".to_owned(), "Shop".to_owned()),
    ];
    // Not the configured head: refused.
    assert!(brief(&path, "chat:cto", "p1", &ryan.id, "Ship", true, &projects).is_err());
    set_head(&path, Some(&ryan.id)).unwrap();
    let text = brief(
        &path,
        "chat:cto",
        "p1",
        &ryan.id,
        "Ship checkout",
        true,
        &projects,
    )
    .unwrap();
    let (_, rest) = text.split_once(BRIEF_MARK).unwrap();
    // Sam works only in Shop, yet is still Ryan's report from General.
    assert!(rest.contains(&format!("id `{}`", maya.id)));
    assert!(rest.contains(&format!("id `{}`", sam.id)));
    assert!(rest.contains("works only in project Shop"));
    assert!(rest.contains("works in any project"));
    assert!(rest.contains("orchestration_destinations"));
    assert!(rest.contains("genuinely ambiguous"));
    assert!(!rest.contains("Zed"));
    let record = lead_for_chat(&path, "chat:cto").unwrap().unwrap();
    assert!(record.cross_project);
    // Reopening keeps the lead; another agent never takes over its history.
    assert!(brief(&path, "chat:cto", "p1", &ryan.id, "More", true, &projects).is_ok());
    set_head(&path, Some(&maya.id)).unwrap();
    let err = brief(&path, "chat:cto", "p1", &maya.id, "Hi", true, &projects).unwrap_err();
    assert!(err.contains("belongs to Ryan"), "{err}");
    assert_eq!(
        lead_for_chat(&path, "chat:cto").unwrap().unwrap().lead_id,
        ryan.id
    );
}

#[test]
fn a_new_conversation_goes_only_to_an_agent_reporting_to_the_person() {
    let path = temp();
    let ryan = save(&path, draft("Ryan", None)).unwrap();
    let vera = save(&path, draft("Vera", Some("p2"))).unwrap();
    let maya = save(&path, under("Maya", Some("p2"), &ryan)).unwrap();
    let glen = save(&path, under("Glen", None, &ryan)).unwrap();
    let projects = [
        ("p1".to_owned(), "General".to_owned()),
        ("p2".to_owned(), "Shop".to_owned()),
    ];
    set_head(&path, Some(&ryan.id)).unwrap();

    // A project-scoped agent at the top is a lead in its own project,
    // briefed under its own name, and not as the cross-project head.
    let text = brief(&path, "chat:vera", "p2", &vera.id, "Tidy", false, &projects).unwrap();
    assert!(text.contains("Lead: Vera"), "{text}");
    let record = lead_for_chat(&path, "chat:vera").unwrap().unwrap();
    assert_eq!(
        (record.lead_id.as_str(), record.project_id.as_str()),
        (vera.id.as_str(), "p2")
    );
    assert!(!record.cross_project);
    assert!(brief(
        &path,
        "chat:vera-x",
        "p2",
        &vera.id,
        "Tidy",
        true,
        &projects
    )
    .is_err());

    // Someone's report is never handed a new conversation, global or not.
    for (report, project) in [(&maya, "p2"), (&glen, "p1")] {
        let key = format!("chat:{}", report.name);
        let err = brief(&path, &key, project, &report.id, "Hi", false, &projects).unwrap_err();
        assert!(err.contains("reports to Ryan"), "{err}");
        assert!(lead_for_chat(&path, &key).unwrap().is_none());
    }

    // A conversation that already belongs to a lead keeps it, even after
    // that lead is moved under someone else.
    save(
        &path,
        TeamDraft {
            id: Some(vera.id.clone()),
            ..under("Vera", Some("p2"), &ryan)
        },
    )
    .unwrap();
    assert!(brief(&path, "chat:vera", "p2", &vera.id, "More", false, &projects).is_ok());
}

#[test]
fn a_global_lead_in_a_project_chat_sees_cross_project_reports() {
    let path = temp();
    let ryan = save(&path, draft("Ryan", None)).unwrap();
    let maya = save(&path, under("Maya", Some("p2"), &ryan)).unwrap();
    let projects = [
        ("p1".to_owned(), "General".to_owned()),
        ("p2".to_owned(), "OctiqFlow".to_owned()),
    ];

    let text = brief(
        &path,
        "chat:project-lead",
        "p1",
        &ryan.id,
        "Fix the roster",
        false,
        &projects,
    )
    .unwrap();

    assert!(text.contains(&format!("id `{}`", maya.id)), "{text}");
    assert!(text.contains("works only in project OctiqFlow"), "{text}");
    assert!(!text.contains("No agent reports to you"), "{text}");
}

#[test]
fn later_turns_refresh_added_removed_and_reassigned_reports() {
    let path = temp();
    let ryan = save(&path, draft("Ryan", None)).unwrap();
    let projects = [
        ("p1".to_owned(), "General".to_owned()),
        ("p2".to_owned(), "OctiqFlow".to_owned()),
    ];
    let first = brief(
        &path,
        "chat:changing-roster",
        "p1",
        &ryan.id,
        "Start",
        false,
        &projects,
    )
    .unwrap();
    assert!(
        first.contains("No eligible agent currently reports to you"),
        "{first}"
    );

    confirm_turn_brief(&path, "chat:changing-roster", &first).unwrap();
    let saved = std::fs::read(&path).unwrap();
    assert_eq!(
        refresh_turn_brief(&path, "chat:changing-roster", "Unchanged".into(), &projects).unwrap(),
        "Unchanged"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        saved,
        "no write for an unchanged roster"
    );

    let maya = save(&path, under("Maya", Some("p2"), &ryan)).unwrap();
    let added =
        refresh_turn_brief(&path, "chat:changing-roster", "Continue".into(), &projects).unwrap();
    assert_eq!(added.split_once(BRIEF_MARK).unwrap().0, "Continue");
    assert!(added.contains(&format!("id `{}`", maya.id)), "{added}");
    assert!(added.contains("works only in project OctiqFlow"), "{added}");
    assert!(added.contains("supersedes any older roster"), "{added}");
    confirm_turn_brief(&path, "chat:changing-roster", &added).unwrap();

    assert_eq!(
        refresh_turn_brief(&path, "chat:changing-roster", "Again".into(), &projects).unwrap(),
        "Again"
    );
    let changed = save(
        &path,
        TeamDraft {
            id: Some(maya.id.clone()),
            role: "New role".into(),
            ..under("Maya", Some("p2"), &ryan)
        },
    )
    .unwrap();
    let role = refresh_turn_brief(&path, "chat:changing-roster", "Role".into(), &projects).unwrap();
    assert!(role.contains("New role"));
    assert_eq!(changed.id, maya.id);

    let mut reassigned = draft("Maya", Some("p2"));
    reassigned.id = Some(maya.id);
    save(&path, reassigned).unwrap();
    let removed = refresh_turn_brief(
        &path,
        "chat:changing-roster",
        "Continue again".into(),
        &projects,
    )
    .unwrap();
    assert!(
        removed.contains("No eligible agent currently reports to you"),
        "{removed}"
    );
    assert!(!removed.contains("id `"), "{removed}");
}

#[test]
fn a_failed_send_does_not_consume_the_new_roster() {
    let home = crate::test_dir::TestDir::new("roster-send-failure");
    let _profile = crate::profile::started_in(&home.0);
    let path = temp();
    let lead = save(&path, draft("Lead", None)).unwrap();
    let key = "chat:roster-offline";
    let initial = brief(&path, key, "p1", &lead.id, "Start", false, &[]).unwrap();
    assert_eq!(
        lead_for_chat(&path, key)
            .unwrap()
            .unwrap()
            .roster_fingerprint,
        None
    );
    confirm_turn_brief(&path, key, &initial).unwrap();
    let before = std::fs::read(&path).unwrap();
    save(&path, under("New Report", None, &lead)).unwrap();
    let saved = std::fs::read(&path).unwrap();
    let prepared = refresh_turn_brief(&path, key, "First attempt".into(), &[]).unwrap();
    let failed = crate::agent_chat::chat_send_user_impl(
        std::sync::Arc::new(crate::agent_chat::ChatManager::default()),
        key.into(),
        prepared,
        None,
        None,
        Some("roster-send".into()),
        None,
    )
    .unwrap_err();
    assert_eq!(failed, "no such chat");
    assert_ne!(before, saved);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        saved,
        "preparation/failure saves no receipt"
    );
    let retry = refresh_turn_brief(&path, key, "Retry".into(), &[]).unwrap();
    assert!(retry.contains("New Report"), "{retry}");
    confirm_turn_brief(&path, key, &retry).unwrap();
    assert_eq!(
        refresh_turn_brief(&path, key, "Again".into(), &[]).unwrap(),
        "Again"
    );
}

#[test]
fn a_roster_receipt_never_waits_on_a_concurrent_roster_mutation() {
    let path = temp();
    let _team = use_test_path(path.to_path_buf());
    let lead = save(&path, draft("Lead", None)).unwrap();
    let key = "chat:roster-lock-order";
    let text = brief(&path, key, "p1", &lead.id, "Start", false, &[]).unwrap();
    let lock = LOCK.lock().unwrap();
    let (sent, received) = std::sync::mpsc::channel();
    let worker = std::thread::spawn({
        let text = text.clone();
        move || {
            note_roster_delivered(key, &text);
            sent.send(()).unwrap();
        }
    });
    let returned = received.recv_timeout(std::time::Duration::from_secs(2));
    drop(lock); // A regressed blocking implementation can still finish.
    worker.join().unwrap();
    assert!(
        returned.is_ok(),
        "provider write waited for the roster lock"
    );
    assert_eq!(
        lead_for_chat(&path, key)
            .unwrap()
            .unwrap()
            .roster_fingerprint,
        None
    );
    confirm_turn_brief(&path, key, &text).unwrap();
    assert!(lead_for_chat(&path, key)
        .unwrap()
        .unwrap()
        .roster_fingerprint
        .is_some());
}

#[test]
fn roster_receipts_cover_the_snapshot_delivered_not_a_later_roster() {
    let path = temp();
    let lead = save(&path, draft("Lead", None)).unwrap();
    let key = "chat:roster-snapshots";
    let initial = brief(&path, key, "p1", &lead.id, "Start", false, &[]).unwrap();
    save(&path, under("New Report", None, &lead)).unwrap();
    // An old initial brief is written after the edit: do not acknowledge
    // the newly added report that it never carried.
    confirm_turn_brief(&path, key, &initial).unwrap();
    let new = refresh_turn_brief(&path, key, "New".into(), &[]).unwrap();
    assert!(new.contains("New Report"));
    let unchanged = std::fs::read(&path).unwrap();
    // A receipt sent to a room seat is not delivery to its lead.
    confirm_turn_brief(&path, "chat:roster-snapshots:seat", &new).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), unchanged);
    let combined = format!("{initial}\n{new}");
    confirm_turn_brief(&path, key, &combined).unwrap();
    assert_eq!(
        refresh_turn_brief(&path, key, "Again".into(), &[]).unwrap(),
        "Again"
    );
}

#[test]
fn roster_refresh_leaves_non_lead_and_initial_brief_text_alone() {
    let path = temp();
    let ryan = save(&path, draft("Ryan", None)).unwrap();
    let initial = brief(&path, "chat:lead", "p1", &ryan.id, "Start", false, &[]).unwrap();
    assert_eq!(
        refresh_turn_brief(&path, "chat:other", "Hello".into(), &[]).unwrap(),
        "Hello"
    );
    assert_eq!(
        refresh_turn_brief(&path, "chat:lead", initial.clone(), &[]).unwrap(),
        initial
    );
}

#[test]
fn project_scoped_managers_keep_project_scoped_rosters() {
    let path = temp();
    let ceo = save(&path, draft("Ceo", None)).unwrap();
    let local = save(&path, draft("Local lead", Some("p1"))).unwrap();
    let local_dev = save(&path, under("Local dev", Some("p1"), &local)).unwrap();
    let foreign = save(&path, under("Foreign lead", Some("p2"), &ceo)).unwrap();
    let foreign_dev = save(&path, under("Foreign dev", Some("p2"), &foreign)).unwrap();

    let text = brief(
        &path,
        "chat:local",
        "p1",
        &local.id,
        "Local work",
        false,
        &[("p1".into(), "One".into()), ("p2".into(), "Two".into())],
    )
    .unwrap();

    assert!(text.contains(&format!("id `{}`", local_dev.id)), "{text}");
    assert!(!text.contains(&foreign.id), "{text}");
    assert!(!text.contains(&foreign_dev.id), "{text}");
    assert!(brief(
        &path,
        "chat:wrong-project",
        "p2",
        &local.id,
        "Wrong project",
        false,
        &[]
    )
    .unwrap_err()
    .contains("no longer works in this project"));
}

#[test]
fn a_front_desk_is_created_in_one_step_on_the_smallest_model_at_its_lowest_effort() {
    let path = temp();
    assert!(
        front_desk(&path).unwrap().is_none(),
        "none until the person makes one"
    );
    let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
    assert_eq!(desk.agent, ChatAgent::Claude);
    assert_eq!(desk.model, FRONT_DESK_MODEL);
    assert_eq!(desk.model, "haiku");
    assert_eq!(desk.effort.as_deref(), Some("low"));
    assert_eq!(desk.access, Access::Read);
    assert!(desk.project_id.is_none() && desk.reports_to.is_none());
    assert_eq!(desk.role, FRONT_DESK_ROLE);
    assert_eq!(front_desk(&path).unwrap().unwrap().id, desk.id);

    // The person picks Codex: the browser sends its smallest model.
    let other = temp();
    let codex = create_front_desk(
        &other,
        FrontDeskDraft {
            name: Some("Reception".into()),
            agent: Some(ChatAgent::Codex),
            model: Some("gpt-5.6-luna".into()),
            effort: None,
        },
    )
    .unwrap();
    assert_eq!(
        (codex.name.as_str(), codex.model.as_str()),
        ("Reception", "gpt-5.6-luna")
    );
    assert_eq!(codex.effort.as_deref(), Some("low"));
    // Codex has no default model here to fall back on.
    assert!(create_front_desk(
        &temp(),
        FrontDeskDraft {
            agent: Some(ChatAgent::Codex),
            ..FrontDeskDraft::default()
        }
    )
    .is_err());
}

#[test]
fn a_changed_front_desk_model_is_what_the_next_front_desk_chat_reads() {
    let path = temp();
    let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
    save(
        &path,
        TeamDraft {
            id: Some(desk.id.clone()),
            model: "sonnet".into(),
            effort: Some("medium".into()),
            access: Some(desk.access),
            role: desk.role.clone(),
            ..draft(&desk.name, None)
        },
    )
    .unwrap();
    let now = front_desk(&path).unwrap().unwrap();
    assert_eq!(
        (now.model.as_str(), now.effort.as_deref()),
        ("sonnet", Some("medium"))
    );
    // Read from the store each time: nothing to restart.
    assert_eq!(now.id, desk.id);
}

#[test]
fn the_head_managers_and_project_agents_cannot_be_the_front_desk() {
    let path = temp();
    let cto = save(&path, draft("Potato", None)).unwrap();
    set_head(&path, Some(&cto.id)).unwrap();
    assert!(set_front_desk(&path, Some(&cto.id))
        .unwrap_err()
        .contains("lead you talk to across projects"));
    let lead = save(&path, draft("Lead", None)).unwrap();
    save(&path, under("Worker", None, &lead)).unwrap();
    assert!(set_front_desk(&path, Some(&lead.id))
        .unwrap_err()
        .contains("manages other agents"));
    let local = save(&path, draft("Local", Some("p1"))).unwrap();
    assert!(set_front_desk(&path, Some(&local.id))
        .unwrap_err()
        .contains("global agent"));
    assert!(front_desk(&path).unwrap().is_none());

    // And the other way round: the front desk stays a router.
    let desk = save(&path, draft("Desk", None)).unwrap();
    set_front_desk(&path, Some(&desk.id)).unwrap();
    assert!(set_head(&path, Some(&desk.id))
        .unwrap_err()
        .contains("front desk"));
    assert!(save(&path, under("Helper", None, &desk))
        .unwrap_err()
        .contains("no agent can report to it"));
    let mut moved = draft("Desk", Some("p1"));
    moved.id = Some(desk.id.clone());
    assert!(save(&path, moved).unwrap_err().contains("stays global"));
    // Clearing and removing leave no front desk behind.
    assert!(set_front_desk(&path, None).unwrap().is_none());
    set_front_desk(&path, Some(&desk.id)).unwrap();
    delete(&path, &desk.id).unwrap();
    assert!(front_desk(&path).unwrap().is_none());
}

#[test]
fn the_front_desk_brief_lists_only_the_persons_reports_and_records_a_hidden_chat() {
    let path = temp();
    let cto = save(&path, draft("Potato", None)).unwrap();
    set_head(&path, Some(&cto.id)).unwrap();
    // Agents reporting to the person, to the head, and in one project.
    let starfall = save(
        &path,
        TeamDraft {
            role: "Writes the Starfall novel chapters.\nKeeps the tone.".into(),
            ..draft("Vesper", Some("p-star"))
        },
    )
    .unwrap();
    let report = save(&path, under("Mango", Some("p-app"), &cto)).unwrap();
    let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
    let projects = [
        ("p-app".to_owned(), "App".to_owned()),
        ("p-star".to_owned(), "starfall-novel".to_owned()),
        ("p-gen".to_owned(), "General".to_owned()),
    ];
    let text = brief(
        &path,
        "chat:desk1",
        "p-gen",
        &desk.id,
        "Draft chapter 3",
        false,
        &projects,
    )
    .unwrap();
    let (person, host) = text.split_once(BRIEF_MARK).unwrap();
    assert_eq!(person, "Draft chapter 3");
    assert!(
        host.starts_with(&format!("Front desk: {}", desk.name)),
        "{host}"
    );
    for agent in [&cto, &starfall] {
        assert!(
            host.contains(&format!("id `{}` · {}", agent.id, agent.name)),
            "{host}"
        );
    }
    // Mango reports to Potato: only named, under Potato's team, so a
    // request for Mango goes to Potato.
    assert!(!host.contains(&format!("id `{}`", report.id)), "{host}");
    assert!(host.contains("their team: Mango"), "{host}");
    assert!(
        host.contains("You route only to the agents below"),
        "{host}"
    );
    assert!(
        !host.contains(&format!("id `{}`", desk.id)),
        "not itself: {host}"
    );
    assert!(
        host.contains("Writes the Starfall novel chapters. Keeps the tone."),
        "{host}"
    );
    assert!(
        host.contains("works only in project starfall-novel (id `p-star`)"),
        "{host}"
    );
    assert!(host.contains("the person's lead across projects"), "{host}");
    assert!(host.contains("id `p-gen` · General (home"), "{host}");
    assert!(host.contains("ask the person one short question"), "{host}");
    assert!(host.contains("fits no registered agent"), "{host}");
    assert!(host.contains("route_chat"), "{host}");
    // Talking an idea through changes the wording, never the settings.
    assert!(
        host.contains("Set `purpose` to \"discuss\" when the person wants to talk"),
        "{host}"
    );
    assert!(
            host.contains("A discussion opens on the agent's own settings like any chat, and its first message says it is a discussion."),
            "{host}"
        );
    assert!(!host.contains("opens read-only"), "{host}");
    // Recorded as a front-desk chat, never as anyone's lead.
    assert!(is_front_desk_chat(&path, "chat:desk1"));
    assert!(lead_for_chat(&path, "chat:desk1").unwrap().is_none());
    assert!(text.len() < 20_000, "bounded");
}

#[test]
fn designating_a_front_desk_changes_none_of_its_earlier_chats() {
    let path = temp();
    let agent = save(&path, draft("Desk", None)).unwrap();
    // An ordinary conversation with it, before it is the front desk.
    brief(&path, "chat:before", "p1", &agent.id, "Hello", false, &[]).unwrap();
    set_front_desk(&path, Some(&agent.id)).unwrap();
    // That chat keeps its lead brief and stays visible.
    let later = brief(&path, "chat:before", "p1", &agent.id, "Again", false, &[]).unwrap();
    assert!(!later.contains("Front desk:"), "{later}");
    assert!(!is_front_desk_chat(&path, "chat:before"));
    // A new one is a front-desk chat; clearing the designation keeps it hidden.
    brief(&path, "chat:after", "p1", &agent.id, "Hello", false, &[]).unwrap();
    assert!(is_front_desk_chat(&path, "chat:after"));
    set_front_desk(&path, None).unwrap();
    assert!(is_front_desk_chat(&path, "chat:after"));
    let plain = brief(&path, "chat:third", "p1", &agent.id, "Hello", false, &[]).unwrap();
    assert!(
        !plain.contains("Front desk:"),
        "no longer the desk: {plain}"
    );
}

#[test]
fn a_front_desk_chat_remembers_its_provider_sessions_and_nothing_else_does() {
    let path = temp();
    let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
    brief(&path, "chat:desk1", "p1", &desk.id, "Hi", false, &[]).unwrap();
    note_front_desk_session(&path, "chat:desk1", ChatAgent::Claude, "sess-1");
    note_front_desk_session(&path, "chat:desk1", ChatAgent::Claude, "sess-1");
    note_front_desk_session(&path, "chat:desk1", ChatAgent::Codex, "sess-1");
    note_front_desk_session(&path, "chat:desk1", ChatAgent::Claude, "sess-2");
    note_front_desk_session(&path, "chat:ordinary", ChatAgent::Claude, "sess-3");
    let chats = front_desk_chats(&path);
    assert_eq!(chats.len(), 1);
    let session = |provider, id: &str| FrontDeskSession {
        provider,
        session_id: id.into(),
    };
    assert_eq!(
        chats[0].sessions,
        vec![
            session(ChatAgent::Claude, "sess-1"),
            session(ChatAgent::Codex, "sess-1"),
            session(ChatAgent::Claude, "sess-2"),
        ]
    );
    assert!(chats[0].session_ids.is_empty(), "never the old shape");
}

/// A record written before sessions carried their provider still reads,
/// with its ids kept apart for `agent_history::without_front_desks`.
#[test]
fn a_front_desk_record_without_providers_still_reads() {
    let path = temp();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
            &path,
            r#"{"agents":[],"front_desk_chats":[{"chatKey":"chat:old","agentId":"a1","sessionIds":["sess-old"],"createdAt":1}]}"#,
        )
        .unwrap();
    let chats = front_desk_chats(&path);
    assert_eq!(chats.len(), 1);
    assert!(chats[0].sessions.is_empty());
    assert_eq!(chats[0].session_ids, vec!["sess-old"]);
    // Learning a new session keeps the old ids where they were.
    note_front_desk_session(&path, "chat:old", ChatAgent::Codex, "sess-new");
    let chats = front_desk_chats(&path);
    assert_eq!(chats[0].session_ids, vec!["sess-old"]);
    assert_eq!(chats[0].sessions.len(), 1);
}

const POLICY: &str = "Work in a git worktree. Never push without asking.";
const STANDING: &str = "Runbook: build with pnpm, then cargo.";

/// `draft`, carrying standing instructions.
fn standing(name: &str, project: Option<&str>, text: &str) -> TeamDraft {
    TeamDraft {
        persistent_prompt: Some(text.into()),
        desktop_tools: None,
        worker_servers: None,
        ..draft(name, project)
    }
}

/// Where `needle` sits in `hay`, failing the test when it is absent.
fn at(hay: &str, needle: &str) -> usize {
    hay.find(needle)
        .unwrap_or_else(|| panic!("{needle:?} missing from {hay}"))
}

/// The policy, then the standing instructions, then the role.
fn in_order(text: &str, role: &str) {
    let policy = at(
        text,
        "Shared agent policy (the person's rules for every agent):",
    );
    let rules = at(text, POLICY);
    let standing = at(text, "Standing instructions for ");
    let runbook = at(text, STANDING);
    let role = at(text, role);
    assert!(
        policy < rules && rules < standing && standing < runbook && runbook < role,
        "{text}"
    );
}

/// A team file written before either field existed reads as having
/// neither, and saving it again leaves them out rather than writing
/// empty values.
#[test]
fn a_team_file_without_the_policy_or_persistent_prompts_still_reads() {
    let path = temp();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
            &path,
            r#"{"agents":[{"id":"agent_old","name":"Old","role":"r","agent":"claude","model":"sonnet","access":"auto","createdAt":1,"updatedAt":1}]}"#,
        )
        .unwrap();
    let old = agent_named(&path, "Old");
    assert_eq!(old.persistent_prompt, "");
    assert_eq!(policy(&path).unwrap(), AgentPolicy::default());
    save(
        &path,
        TeamDraft {
            id: Some(old.id.clone()),
            ..draft("Old", None)
        },
    )
    .unwrap();
    let raw = fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("persistentPrompt"), "{raw}");
    assert!(!raw.contains("agent_policy"), "{raw}");
}

#[test]
fn the_agent_policy_is_saved_trimmed_capped_and_cleared() {
    let path = temp();
    let saved = set_policy(&path, &format!("  {POLICY}\n")).unwrap();
    assert_eq!(saved.text, POLICY);
    assert!(saved.updated_at > 0);
    assert_eq!(policy(&path).unwrap(), saved);
    // Stored beside the agents, under its own key.
    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"agent_policy\""), "{raw}");

    assert!(set_policy(&path, &"x".repeat(AGENT_POLICY_MAX)).is_ok());
    assert_eq!(
        set_policy(&path, &"x".repeat(AGENT_POLICY_MAX + 1)).unwrap_err(),
        "The agent policy is longer than 4000 characters."
    );
    assert_eq!(policy(&path).unwrap().text.len(), AGENT_POLICY_MAX);

    let cleared = set_policy(&path, "").unwrap();
    assert_eq!(cleared.text, "");
    assert_eq!(policy(&path).unwrap().text, "");
}

/// What the person approved was a change to one version of the policy.
#[test]
fn a_policy_change_waits_on_the_version_it_was_proposed_against() {
    let path = temp();
    let first = set_policy(&path, "First").unwrap();
    let second = set_policy_unchanged(&path, "Second", first.updated_at).unwrap();
    assert!(second.updated_at > first.updated_at);
    let stale = set_policy_unchanged(&path, "Third", first.updated_at).unwrap_err();
    assert!(stale.contains("changed while this waited"), "{stale}");
    assert_eq!(policy(&path).unwrap().text, "Second");
}

#[test]
fn a_persistent_prompt_is_capped_kept_when_absent_and_cleared_by_empty() {
    let path = temp();
    let long = "p".repeat(PERSISTENT_PROMPT_MAX);
    let ada = save(&path, standing("Ada", None, &long)).unwrap();
    assert_eq!(ada.persistent_prompt, long);
    assert_eq!(
        save(&path, standing("Bo", None, &format!("{long}p"))).unwrap_err(),
        "The agent's persistent prompt is longer than 8000 characters."
    );
    // The role keeps its own, smaller cap.
    let wordy = TeamDraft {
        role: "r".repeat(ROLE_MAX + 1),
        ..draft("Cy", None)
    };
    assert_eq!(
        save(&path, wordy).unwrap_err(),
        "The agent's role is longer than 2000 characters."
    );
    // An edit that does not mention it keeps it, as the avatar is kept.
    let renamed = save(
        &path,
        TeamDraft {
            id: Some(ada.id.clone()),
            ..draft("Ada Lovelace", None)
        },
    )
    .unwrap();
    assert_eq!(renamed.persistent_prompt, long);
    let replaced = save(
        &path,
        TeamDraft {
            id: Some(ada.id.clone()),
            ..standing("Ada Lovelace", None, &format!("  {STANDING} "))
        },
    )
    .unwrap();
    assert_eq!(replaced.persistent_prompt, STANDING);
    let cleared = save(
        &path,
        TeamDraft {
            id: Some(ada.id.clone()),
            ..standing("Ada Lovelace", None, "")
        },
    )
    .unwrap();
    assert_eq!(cleared.persistent_prompt, "");
    // It survives a fresh read of the file.
    save(
        &path,
        TeamDraft {
            id: Some(ada.id.clone()),
            ..standing("Ada Lovelace", None, STANDING)
        },
    )
    .unwrap();
    assert_eq!(
        agent_named(&path, "Ada Lovelace").persistent_prompt,
        STANDING
    );
}

#[test]
fn the_standing_brief_leaves_out_what_is_empty() {
    let path = temp();
    let plain = save(&path, draft("Plain", None)).unwrap();
    assert_eq!(standing_brief("", &plain), "");
    assert_eq!(standing_brief("  \n", &plain), "");
    let only_policy = standing_brief(POLICY, &plain);
    assert!(only_policy.contains(POLICY));
    assert!(!only_policy.contains("Standing instructions"));
    assert!(only_policy.ends_with("\n\n"));
    let ruled = save(&path, standing("Ruled", None, STANDING)).unwrap();
    let only_standing = standing_brief("", &ruled);
    assert!(!only_standing.contains("Shared agent policy"));
    assert!(only_standing.starts_with("Standing instructions for Ruled:\n"));
    // A worker with neither is told only who it is.
    assert_eq!(
            worker_identity("", &plain),
            "You are Plain, the registered OctiqFlow agent this task is assigned to. Your role: builds things."
        );
}

/// A conversation the person starts, a handover and a front-desk route
/// all brief the agent the same way: policy, standing instructions, role.
#[test]
fn every_lead_brief_carries_the_policy_then_standing_instructions_then_the_role() {
    let path = temp();
    set_policy(&path, POLICY).unwrap();
    let lead = save(&path, standing("Lead", None, STANDING)).unwrap();
    let briefs = [
        brief(&path, "chat:direct", "p1", &lead.id, "Fix it", false, &[]).unwrap(),
        handover_brief(&path, "chat:handed", "p1", &lead.id, "Fix it", &[]).unwrap(),
        route_brief(&path, "chat:routed", "p1", &lead.id, "Fix it", false, &[]).unwrap(),
    ];
    for text in briefs {
        let (person, host) = text.split_once(BRIEF_MARK).unwrap();
        // The person's bubble is still only their words.
        assert_eq!(person, "Fix it");
        assert!(
            host.starts_with("Lead: Lead\n\nShared agent policy"),
            "{host}"
        );
        in_order(host, "Your role: builds things.");
    }
    // Without either, the brief is what it always was.
    set_policy(&path, "").unwrap();
    let plain = save(&path, draft("Plain", None)).unwrap();
    let text = brief(&path, "chat:plain", "p1", &plain.id, "Fix it", false, &[]).unwrap();
    assert!(text.contains(&format!(
        "{BRIEF_MARK}Lead: Plain\n\nYou are Plain, a registered agent"
    )));
    assert!(!text.contains("Shared agent policy"));
    assert!(!text.contains("Standing instructions"));
}

#[test]
fn the_front_desk_is_briefed_with_the_policy_and_lists_roles_only() {
    let path = temp();
    set_policy(&path, POLICY).unwrap();
    let worker = save(&path, standing("Vesper", None, "SECRET-RUNBOOK")).unwrap();
    let desk = create_front_desk(&path, FrontDeskDraft::default()).unwrap();
    save(
        &path,
        TeamDraft {
            id: Some(desk.id.clone()),
            role: FRONT_DESK_ROLE.into(),
            ..standing(&desk.name, None, STANDING)
        },
    )
    .unwrap();
    let text = brief(&path, "chat:desk", "p1", &desk.id, "Help", false, &[]).unwrap();
    let (_, host) = text.split_once(BRIEF_MARK).unwrap();
    in_order(host, "Your role: Listens to what the person wants");
    // The roster carries each agent's role, never its standing rules.
    assert!(host.contains(&format!("id `{}` · Vesper — builds things", worker.id)));
    assert!(!host.contains("SECRET-RUNBOOK"), "{host}");
}

/// An orchestration worker is told who it is after the task's dispatch:
/// the policy, its standing instructions and its role, then its memory.
#[test]
fn a_worker_brief_carries_the_policy_standing_instructions_and_role() {
    let path = temp();
    set_policy(&path, POLICY).unwrap();
    let ada = save(&path, standing("Ada", None, STANDING)).unwrap();
    let (me, text) = assignee_brief(&path, &ada.id, "p1", true).unwrap();
    assert_eq!(me.id, ada.id);
    in_order(&text, "You are Ada, the registered OctiqFlow agent");
    assert!(
        at(&text, "Your role: builds things.") < at(&text, "vault_agent_memory_read"),
        "{text}"
    );
    assert!(assignee_brief(&path, "agent_gone", "p1", true).is_none());
}

/// Wherever an agent is listed to ANOTHER agent, only its role shows.
#[test]
fn rosters_list_the_role_and_never_the_persistent_prompt() {
    let path = temp();
    set_policy(&path, POLICY).unwrap();
    let lead = save(&path, draft("Lead", None)).unwrap();
    let web = save_team(&path, team_draft("Web", None)).unwrap();
    let manager = save(
        &path,
        TeamDraft {
            team_id: Some(web.id.clone()),
            ..under("Mid", None, &lead)
        },
    )
    .unwrap();
    let hidden = "HIDDEN-STANDING-RULES";
    save(
        &path,
        TeamDraft {
            persistent_prompt: Some(hidden.into()),
            desktop_tools: None,
            worker_servers: None,
            team_id: Some(web.id.clone()),
            ..under("Report", None, &manager)
        },
    )
    .unwrap();
    save(
        &path,
        TeamDraft {
            persistent_prompt: Some(hidden.into()),
            desktop_tools: None,
            worker_servers: None,
            ..under("Other", None, &lead)
        },
    )
    .unwrap();
    // The lead's own brief lists its reports.
    let lead_text = brief(&path, "chat:lead", "p1", &lead.id, "Plan it", false, &[]).unwrap();
    assert!(lead_text.contains("Other — builds things"), "{lead_text}");
    // A later turn's roster, after the initial brief reached the provider.
    confirm_turn_brief(&path, "chat:lead", &lead_text).unwrap();
    let later = refresh_turn_brief(&path, "chat:lead", "More".into(), &[]).unwrap();
    assert_eq!(later, "More");
    // A second-level manager's roster.
    let split = manager_brief(&path, "p1", &manager.id, "task_1", "run_1")
        .unwrap()
        .unwrap();
    assert!(split.contains("Report — builds things"), "{split}");
    // A worker's peer roster.
    let team = list(&path, None, true).unwrap();
    let teams = teams(&path).unwrap();
    let mid = team.iter().find(|a| a.id == manager.id).unwrap();
    let peers = peer_brief(&team, &teams, mid, "p1", true).unwrap();
    assert!(peers.contains("Report — builds things"), "{peers}");
    for text in [&lead_text, &later, &split, &peers] {
        assert!(!text.contains(hidden), "{text}");
    }
    // The policy is the lead's own, never repeated per roster line.
    assert_eq!(lead_text.matches(POLICY).count(), 1, "{lead_text}");
}
