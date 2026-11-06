//! The facts shared by whole-app readers. Long run detail is fetched on demand.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summary_preserves_the_one_reading_of_waits_holds_and_progress() {
        let mut view = json!({
            "runs":[{"id":"r", "status":"waiting", "coordinatorChatKey":"chat:lead", "planApproval":{"status":"pending","revision":7}}],
            "tasks":[{"id":"t","runId":"r","title":"Review","status":"completed","kind":"review","verdict":"fail","activeAttemptId":"a","dependsOn":["prior"],"approvedAt":5,"splitBy":"parent-attempt","parentTaskId":"parent","supersededBy":"replacement","heldByPlan":false,"heldByReopen":true,"retryLimit":2,"retriesUsed":2,"retrying":true,"failure":{"kind":"check_failed","awaits":"person"},"spec":"LONG","result":"LONG","reopens":[{"at":10,"noticeDelivered":false,"spec":"LONG","previousSpec":"LONG"}],"peerRequest":{"requestedBy":{"id":"agent"},"maxMinutes":5,"output":"LONG"}}],
            "attempts":[{"id":"a","runId":"r","taskId":"t","workerChatKey":"chat:worker","status":"completed","number":2,"usage":{"input":5,"output":6},"context":{"tokens":3,"window":200},"execution":{"state":"awaiting_report","lastProgress":"LONG","pendingTools":{"tool":"LONG"},"lastActivityAt":12},"proposedReport":{"id":"p","text":"LONG","confirmedAt":null},"summary":"LONG","filesModified":["LONG"]}],
            "gates":[{"id":"g","runId":"r","aboutTaskId":"t","status":"open","awaits":"person","question":"LONG"},{"id":"old","runId":"r","status":"answered"}],
            "nativeDecisions":[{"id":"d","runId":"r","taskId":"t","attemptId":"a","status":"pending","awaits":"nobody","continuation":"unavailable","kind":"outage","groupId":"outage"}],
            "reports":{"chat:worker":{"reportedAt":12,"steps":[{"title":"Verify","state":"active"}]},"unrelated":{"steps":[]}},
            "messages":[{"runId":"r","body":"LONG"}],"notifications":[{"runId":"r","body":"LONG"}],"services":[],"bridges":[],"peerAsks":[]
        });
        let before = view.clone();
        project(&mut view);
        for field in ["status","kind","verdict","activeAttemptId","dependsOn","approvedAt","splitBy","parentTaskId","supersededBy","heldByPlan","heldByReopen","retryLimit","retriesUsed","retrying","failure"] {
            assert_eq!(view["tasks"][0][field], before["tasks"][0][field], "task {field}");
        }
        assert_eq!(view["tasks"][0]["reopens"][0], json!({"at":10,"noticeDelivered":false}));
        assert_eq!(view["runs"][0]["planApproval"], before["runs"][0]["planApproval"]);
        assert_eq!(view["attempts"][0]["usage"], before["attempts"][0]["usage"]);
        assert_eq!(view["attempts"][0]["context"], before["attempts"][0]["context"]);
        assert_eq!(view["attempts"][0]["proposedReport"]["id"], "p");
        assert_eq!(view["attempts"][0]["execution"]["state"], "awaiting_report");
        assert!(view["attempts"][0]["execution"].get("lastProgress").is_none());
        assert_eq!(view["gates"].as_array().unwrap().len(), 1);
        assert_eq!(view["gates"][0]["aboutTaskId"], "t");
        assert_eq!(view["gates"][0]["awaits"], "person");
        assert_eq!(view["nativeDecisions"], before["nativeDecisions"]);
        assert_eq!(view["reports"]["chat:worker"]["steps"], before["reports"]["chat:worker"]["steps"]);
        assert!(view["reports"].get("unrelated").is_none());
        assert_eq!(view["runs"][0]["counts"]["tasks"], 1);
        assert_eq!(view["runs"][0]["counts"]["messages"], 1);
        assert!(view["messages"].as_array().unwrap().is_empty());
        assert!(!view.to_string().contains("LONG"));
    }

    #[test]
    fn summary_size_does_not_grow_with_run_history_text() {
        let long = "x".repeat(20_000);
        let mut view = json!({"runs":[],"tasks":[],"attempts":[],"gates":[],"nativeDecisions":[],"reports":{},"messages":[],"notifications":[],"services":[],"bridges":[],"peerAsks":[]});
        for i in 0..800 {
            let run = format!("r{}", i / 8);
            if i % 8 == 0 { view["runs"].as_array_mut().unwrap().push(json!({"id":run,"status":"running"})); }
            view["tasks"].as_array_mut().unwrap().push(json!({"id":format!("t{i}"),"runId":run,"title":"Task","status":"running","spec":long,"result":long,"card":{"problem":long},"approved":{"result":long},"reopens":[{"at":3,"noticeDelivered":false,"spec":long,"previousSpec":long}]}));
            view["attempts"].as_array_mut().unwrap().push(json!({"id":format!("a{i}"),"runId":run,"taskId":format!("t{i}"),"status":"running","summary":long,"execution":{"state":"executing","lastProgress":long,"pendingTools":{"tool":long}}}));
        }
        let full = serde_json::to_vec(&view).unwrap().len();
        project(&mut view);
        let small = serde_json::to_vec(&view).unwrap().len();
        assert!(full > 100_000_000);
        assert!(small < 1_000_000, "summary: {small}, full: {full}");
        assert!(small * 100 < full);
        assert_eq!(view["runs"].as_array().unwrap().len(), 100);
        assert_eq!(view["tasks"].as_array().unwrap().len(), 800);
    }
}
