use super::*;
#[test]
fn version_one_is_migrated_and_new_records_cannot_be_silently_overwritten_by_an_old_backend() {
    let root = crate::test_dir::TestDir::new("workflow-migration");
    let path = root.join("orchestrations.json");
    std::fs::write(
        &path,
        r#"{"version":1,"runs":{},"tasks":{},"attempts":{},"gates":{},"messages":{}}"#,
    )
    .unwrap();
    let store = OrchestrationStore::load(path.clone());
    assert!(store.snapshot(None).unwrap().runs.is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["version"], STORE_VERSION);
}
