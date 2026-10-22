//! What an agent may send, rule by rule (`rules.rs`), and the starter
//! assets held to the same rules.
use serde_json::{json, Value};

use super::model::*;
use super::rules::*;
use super::starter;

fn asset(kind: &str, parts: Value) -> Value {
    json!({ "name": "Thing", "kind": kind, "parts": parts })
}

fn block(size: [f64; 3], at: [f64; 3]) -> Value {
    json!({ "shape": "box", "size": size, "at": at, "color": "#c8956b" })
}

fn refused(input: Value) -> String {
    check_asset(input).expect_err("refused")
}

/// Four walls 1.8 m high round a 5 × 4 m floor, with a 1.2 m doorway in the
/// front and a lintel over it: a building that passes.
fn walls() -> Vec<Value> {
    vec![
        block([5.0, 0.06, 4.0], [0.0, 0.03, 0.0]),
        block([5.0, 1.8, 0.15], [0.0, 0.9, -1.925]),
        block([0.15, 1.8, 3.7], [-2.425, 0.9, 0.0]),
        block([0.15, 1.8, 3.7], [2.425, 0.9, 0.0]),
        block([1.9, 1.8, 0.15], [-1.55, 0.9, 1.925]),
        block([1.9, 1.8, 0.15], [1.55, 0.9, 1.925]),
        block([1.2, 0.3, 0.15], [0.0, 1.65, 1.925]),
    ]
}

fn building(extra: &[Value]) -> Value {
    let mut parts = walls();
    parts.extend(extra.iter().cloned());
    asset("building", json!(parts))
}

#[test]
fn an_asset_is_kept_the_way_the_file_keeps_it() {
    let (draft, id) = check_asset(json!({
        "name": "  Cosy armchair ", "kind": "Furniture", "use": "seat",
        "spot": { "at": [0, 0.3, 0.05], "face": 270 },
        "assetId": " a_1 ",
        "parts": [
            { "shape": "round", "size": [0.9004, 0.3, 0.8], "at": [0, 0.15, 0], "turn": [0, 0, 0], "color": "#C8796B" },
            { "shape": "ROUND", "size": [0.9, 0.6, 0.2], "at": [0, 0.45, -0.3], "turn": [-8, 360, 0], "color": "#c8796b", "finish": "matte" },
        ],
    }))
    .unwrap();
    assert_eq!(id.as_deref(), Some("a_1"));
    assert_eq!(draft.name, "Cosy armchair");
    assert_eq!(draft.kind, Kind::Furniture);
    assert_eq!(draft.r#use, Some(Use::Seat));
    assert_eq!(
        draft.spot,
        Some(Spot {
            at: [0.0, 0.3, 0.05],
            face: -90.0
        })
    );
    // Kept to the millimetre, a turn of nothing left out, colours in lower
    // case, and a whole turn written once.
    assert_eq!(draft.parts[0].size, [0.9, 0.3, 0.8]);
    assert_eq!(draft.parts[0].turn, None);
    assert_eq!(draft.parts[0].color, "#c8796b");
    assert_eq!(draft.parts[1].shape, Shape::Round);
    assert_eq!(draft.parts[1].turn, Some([-8.0, 0.0, 0.0]));
    assert_eq!(draft.parts[1].finish, Some(Finish::Matte));
    // `use: none` is the default, and is left out.
    let (draft, _) = check_asset(json!({
        "name": "Lamp", "kind": "decor", "use": "none",
        "parts": [block([0.3, 1.2, 0.3], [0.0, 0.6, 0.0])],
    }))
    .unwrap();
    assert_eq!(draft.r#use, None);
}

#[test]
fn names_kinds_slots_and_uses_are_checked() {
    let one = || json!([block([0.2, 0.2, 0.2], [0.0, 0.1, 0.0])]);
    for (input, said) in [
        (
            json!({ "kind": "decor", "parts": one() }),
            "Give the asset a name.",
        ),
        (
            json!({ "name": "  ", "kind": "decor", "parts": one() }),
            "Give the asset a name.",
        ),
        (
            json!({ "name": "A\nB", "kind": "decor", "parts": one() }),
            "one line",
        ),
        (
            json!({ "name": "x".repeat(61), "kind": "decor", "parts": one() }),
            "longer than 60",
        ),
        (
            json!({ "name": "Hat", "kind": "hat", "parts": one() }),
            "kind \"hat\" is not one of: accessory, furniture, decor, building.",
        ),
        (
            json!({ "name": "Hat", "kind": "accessory", "parts": one() }),
            "An accessory needs a slot",
        ),
        (
            json!({ "name": "Hat", "kind": "accessory", "slot": "tail", "parts": one() }),
            "slot \"tail\" is not one of",
        ),
        (
            json!({ "name": "Desk", "kind": "furniture", "slot": "head", "parts": one() }),
            "Only an accessory has a slot",
        ),
        (
            json!({ "name": "Hut", "kind": "building", "use": "bed", "parts": one() }),
            "use is for furniture and decor only",
        ),
        (
            json!({ "name": "Chair", "kind": "furniture", "use": "throne", "parts": one() }),
            "use \"throne\" is not one of: seat, desk, bed, read, paint, garden, perform, play, observe, none.",
        ),
        (
            json!({ "name": "Chair", "kind": "furniture", "spot": { "at": [0, 0, 0] }, "parts": one() }),
            "needs a use",
        ),
        (
            json!({ "name": "Chair", "kind": "furniture", "colour": "#ffffff", "parts": one() }),
            "unknown field `colour`",
        ),
    ] {
        let why = refused(input.clone());
        assert!(why.contains(said), "{input}: {why}");
    }
    // Exactly 60 characters, in any script, is a name.
    assert!(
        check_asset(json!({ "name": "é".repeat(60), "kind": "decor", "parts": one() })).is_ok()
    );
}

#[test]
fn parts_are_checked_one_by_one_and_named_by_number() {
    let ok = block([0.2, 0.2, 0.2], [0.0, 0.1, 0.0]);
    let with = |bad: Value| asset("furniture", json!([ok.clone(), bad]));
    for (input, said) in [
        (
            asset("furniture", json!([])),
            "at least one part".to_string(),
        ),
        (
            asset("furniture", json!(vec![ok.clone(); 61])),
            "A furniture is at most 60 parts; this one has 61.".into(),
        ),
        (
            with(
                json!({ "shape": "cube", "size": [1, 1, 1], "at": [0, 0.5, 0], "color": "#ffffff" }),
            ),
            "Part 2: shape \"cube\"".into(),
        ),
        (
            with(block([0.019, 0.2, 0.2], [0.0, 0.1, 0.0])),
            "Part 2: every size is 0.02 to 3 m for furniture (one is 0.019)".into(),
        ),
        (
            with(block([0.2, 3.001, 0.2], [0.0, 1.0, 0.0])),
            "Part 2: every size is 0.02 to 3 m".into(),
        ),
        (
            with(json!({ "shape": "box", "size": [1, 1, 1], "at": [0, 0.5, 0], "color": "red" })),
            "Part 2: color must be #rrggbb (it is \"red\")".into(),
        ),
        (
            with(
                json!({ "shape": "box", "size": [1, 1, 1], "at": [0, 0.5, 0], "color": "#ffffff", "finish": "velvet" }),
            ),
            "Part 2: finish \"velvet\"".into(),
        ),
        (
            with(json!({ "shape": "box", "size": [1, 1], "at": [0, 0.5, 0], "color": "#ffffff" })),
            "Part 2 is not a part".into(),
        ),
        (
            with(
                json!({ "shape": "box", "size": [1, 1, 1], "at": [0, 0.5, 0], "colour": "#ffffff" }),
            ),
            "Part 2 is not a part".into(),
        ),
    ] {
        let why = refused(input.clone());
        assert!(why.contains(&said), "{said}: {why}");
    }
    // Each kind has its own count: a decor takes 80, a building 200.
    assert!(check_asset(asset("decor", json!(vec![ok.clone(); 80]))).is_ok());
    assert!(refused(asset("decor", json!(vec![ok.clone(); 81]))).contains("at most 80"));
    let tiny = block([0.1, 0.1, 0.1], [0.0, 0.05, 0.0]);
    assert!(check_asset(asset("building", json!(vec![tiny.clone(); 200]))).is_ok());
    assert!(refused(asset("building", json!(vec![tiny; 201]))).contains("at most 200"));
}

#[test]
fn the_turn_is_the_xyz_euler_three_js_applies() {
    // Rx·Ry·Rz: a bar along x, turned 90° about x and then about y, ends up
    // along y, as three.js turns it.
    let r = rotation([90.0, 90.0, 0.0]);
    let along = [r[0][0], r[1][0], r[2][0]];
    assert!(along[0].abs() < 1e-12 && (along[1] - 1.0).abs() < 1e-12 && along[2].abs() < 1e-12);
    // About z alone, +x goes to +y.
    let r = rotation([0.0, 0.0, 90.0]);
    assert!((r[1][0] - 1.0).abs() < 1e-12);
    // About y alone, +x goes to -z: the same turn a placement makes.
    let r = rotation([0.0, 90.0, 0.0]);
    assert!((r[2][0] + 1.0).abs() < 1e-12);
    let bounds = Bounds {
        min: [-1.0, 0.0, -0.1],
        max: [1.0, 1.0, 0.1],
    };
    let turned = placed_box(&bounds, 0.0, 0.0, 90.0, 0.0);
    assert!(turned
        .iter()
        .all(|p| p[0].abs() <= 0.1 + 1e-9 && p[1].abs() <= 1.0 + 1e-9));
    let bar = Part {
        shape: Shape::Block,
        size: [2.0, 0.02, 0.02],
        at: [0.0, 1.0, 0.0],
        turn: Some([90.0, 90.0, 0.0]),
        color: "#ffffff".into(),
        finish: None,
    };
    let bounds = part_bounds(&bar);
    assert!((bounds.max[1] - 2.0).abs() < 1e-9 && (bounds.min[1] - 0.0).abs() < 1e-9);
}

#[test]
fn every_part_stays_within_its_kinds_bounds_once_turned() {
    // Right at the edge is in; a millimetre past it is out.
    assert!(check_asset(asset(
        "furniture",
        json!([block([1.0, 0.2, 1.0], [1.0, 0.1, 0.0])])
    ))
    .is_ok());
    let why = refused(asset(
        "furniture",
        json!([block([1.0, 0.2, 1.0], [1.001, 0.1, 0.0])]),
    ));
    assert!(
        why.contains("Part 1 (box, 1 × 0.2 × 1 m at [1.001, 0.1, 0]) reaches x = 1.501"),
        "{why}"
    );
    assert!(
        why.contains("furniture stays within x, z ±1.5 and y -0.05..2.5"),
        "{why}"
    );
    // A square slab fits as it is, and sticks out once turned 45° about y.
    let slab =
        json!({ "shape": "box", "size": [2.9, 0.1, 2.9], "at": [0, 0.05, 0], "color": "#ffffff" });
    assert!(check_asset(asset("furniture", json!([slab]))).is_ok());
    let mut turned = slab.clone();
    turned["turn"] = json!([0, 45, 0]);
    assert!(refused(asset("furniture", json!([turned]))).contains("once turned"));
    // A part may sink 5 cm into the ground, and no further.
    assert!(check_asset(asset(
        "decor",
        json!([block([0.2, 0.2, 0.2], [0.0, 0.05, 0.0])])
    ))
    .is_ok());
    let why = refused(asset(
        "decor",
        json!([block([0.2, 0.2, 0.2], [0.0, 0.04, 0.0])]),
    ));
    assert!(why.contains("reaches y = -0.06"), "{why}");
    // An accessory hangs off its anchor: down to -0.6, up to 0.9, ±0.6.
    let hat = |part: Value| json!({ "name": "Hat", "kind": "accessory", "slot": "head", "parts": [part] });
    assert!(check_asset(hat(block([1.2, 0.2, 1.2], [0.0, -0.5, 0.0]))).is_ok());
    assert!(refused(hat(block([1.2, 0.2, 1.2], [0.0, -0.501, 0.0]))).contains("y = -0.601"));
    assert!(refused(hat(block([0.2, 0.2, 0.2], [0.0, 0.85, 0.0]))).contains("y = 0.95"));
    // A building reaches 3 m up and ±5 across.
    check_asset(building(&[
        block([10.0, 1.0, 0.2], [0.0, 0.5, 3.0]),
        block([0.2, 1.0, 0.2], [0.0, 2.5, 0.0]),
    ]))
    .unwrap();
    assert!(refused(asset(
        "building",
        json!([block([0.2, 0.2, 0.2], [0.0, 2.95, 0.0])])
    ))
    .contains("y = 3.05"));
    assert!(refused(building(&[block([10.0, 1.0, 0.2], [0.001, 0.5, 3.0])])).contains("x = 5.001"));
    // Longer than the kind's largest extent is refused as a size first.
    assert!(
        refused(building(&[block([10.002, 1.0, 0.2], [0.0, 0.5, 3.0])])).contains("0.02 to 10 m")
    );
}

#[test]
fn a_spot_needs_a_use_and_stays_near_its_asset() {
    let chair = |spot: Value| {
        json!({ "name": "Chair", "kind": "furniture", "use": "seat", "spot": spot,
                "parts": [block([0.5, 0.35, 0.5], [0.0, 0.175, 0.0])] })
    };
    assert!(check_asset(chair(json!({ "at": [2.5, 0.35, -2.5], "face": 90 }))).is_ok());
    let why = refused(chair(json!({ "at": [2.6, 0.35, 0], "face": 0 })));
    assert!(
        why.contains("within 1 m of its bounds (x, z ±2.5, y -1.05..3.5)"),
        "{why}"
    );
    assert!(refused(chair(json!({ "face": 0 }))).contains("not a spot"));
}

#[test]
fn walls_with_a_doorway_and_a_lintel_are_a_building() {
    check_asset(building(&[])).unwrap();
    // A wall turned to stand across a corner is still a wall: it is thin one
    // way seen from above, whichever way that is.
    let diagonal = json!({
        "shape": "round", "size": [4.0, 1.8, 0.2], "at": [0, 0.9, 0], "turn": [0, 45, 0],
        "color": "#fdf8ef",
    });
    check_asset(building(&[diagonal])).unwrap();
}

#[test]
fn a_part_above_1_2_m_may_be_half_a_metre_thick_and_no_more() {
    // A post half a metre square, all the way up: thin enough.
    check_asset(building(&[block([0.5, 2.0, 0.5], [0.0, 1.0, 0.0])])).unwrap();
    // A millimetre thicker both ways is a block up there.
    let why = refused(building(&[block([0.501, 2.0, 0.501], [0.0, 1.0, 0.0])]));
    assert!(why.starts_with(ROOFLESS), "{why}");
    assert!(
        why.contains("part 8 (box, 0.501 × 2 × 0.501 m, from 0 to 2 m up) is more than 0.5 m thick both ways above 1.2 m"),
        "{why}"
    );
    // Thick one way only is a wall, however long.
    check_asset(building(&[block([0.501, 2.0, 0.2], [0.0, 1.0, 0.0])])).unwrap();
    // Whatever stays under 1.2 m may be as thick as it likes: a floor, a
    // bed of soil, a low block.
    check_asset(building(&[block([2.0, 1.2, 2.0], [0.0, 0.6, 0.0])])).unwrap();
    assert!(
        refused(building(&[block([2.0, 1.202, 2.0], [0.0, 0.601, 0.0])])).starts_with(ROOFLESS)
    );
}

#[test]
fn a_sloped_roof_is_refused() {
    let roof = json!({
        "shape": "box", "size": [5.2, 0.1, 2.4], "at": [0, 2.3, 1.0], "turn": [30, 0, 0],
        "color": "#e07a5f",
    });
    let why = refused(building(&[roof]));
    assert!(why.starts_with(ROOFLESS), "{why}");
    assert!(why.contains("part 8 (box, 5.2 × 0.1 × 2.4 m"), "{why}");
    assert!(why.contains("more than 0.5 m thick both ways"), "{why}");
    // The same slab as a wall standing up is fine.
    let wall = json!({
        "shape": "box", "size": [5.0, 0.1, 1.5], "at": [0, 1.0, 0.0], "turn": [90, 0, 0],
        "color": "#e07a5f",
    });
    check_asset(building(&[wall])).unwrap();
}

#[test]
fn beams_above_1_5_m_may_cover_15_percent_of_the_floor_and_no_more() {
    // The walls' box is 5 × 4 = 20 m². The lintel is wholly above 1.5 m
    // already: 1.2 × 0.15 = 0.18 m². Two beams of 5 × 0.282 bring it to
    // exactly 3 m², 15%.
    let beam = |depth: f64, z: f64| block([5.0, 0.1, depth], [0.0, 1.9, z]);
    check_asset(building(&[beam(0.282, -1.0), beam(0.282, 1.0)])).unwrap();
    // A millimetre deeper is past it, and the refusal names the largest.
    let why = refused(building(&[beam(0.282, -1.0), beam(0.283, 1.0)]));
    assert!(why.starts_with(ROOFLESS), "{why}");
    assert!(
        why.contains("the overhead parts reaching above 1.5 m cover 15.0% of the building's floor (3.005 of 20 m²), and at most 15% may be covered"),
        "{why}"
    );
    assert!(
        why.contains("The largest is part 9 (box, 5 × 0.1 × 0.283 m, from 1.85 to 1.95 m up)"),
        "{why}"
    );
    // A sparse beam straddling 1.5 m still fits within the aggregate budget.
    check_asset(building(&[block([5.0, 0.4, 0.45], [0.0, 1.6, 0.0])])).unwrap();
}

#[test]
fn narrow_strips_straddling_the_height_limit_cannot_tile_an_opaque_roof() {
    for bottom in [1.4, 1.499, 1.5] {
        let mut parts = vec![block([8.0, 0.06, 8.0], [0.0, 0.03, 0.0])];
        for i in 0..20 {
            parts.push(block(
                [0.4, 0.2, 8.0],
                [-3.8 + i as f64 * 0.4, bottom + 0.1, 0.0],
            ));
        }
        let why = refused(asset("building", json!(parts)));
        assert!(why.starts_with(ROOFLESS), "{why}");
        assert!(why.contains("cover 100.0%"), "{why}");
    }
}

#[test]
fn a_look_patch_names_real_words_and_wears_only_what_it_may() {
    let island = {
        let mut island: Island = serde_json::from_value(json!({
            "version": 1, "rev": 1, "seed": 1, "createdAt": 0, "updatedAt": 0, "radius": 30,
        }))
        .unwrap();
        for (id, kind, slot) in [
            ("a_hat", "accessory", Some("head")),
            ("a_desk", "furniture", None),
        ] {
            let mut input = json!({ "name": id, "kind": kind,
                "parts": [block([0.2, 0.2, 0.2], [0.0, 0.1, 0.0])] });
            if let Some(slot) = slot {
                input["slot"] = json!(slot);
            }
            let (draft, _) = check_asset(input).unwrap();
            island.assets.push(Asset {
                id: id.into(),
                rev: 1,
                name: draft.name,
                kind: draft.kind,
                slot: draft.slot,
                r#use: None,
                spot: None,
                parts: draft.parts,
                by: Maker::island(),
                made_at: 0,
                updated_at: 0,
            });
        }
        island
    };
    let anyone = |_: &Asset| true;
    let change = check_look(
        json!({ "frame": "Stout", "shell": "#ABCDEF", "eyes": "chevron", "antenna": "none",
                "worn": { "head": "a_hat", "neck": null } }),
        &island,
        &anyone,
    )
    .unwrap();
    assert_eq!(change.frame, Some(Frame::Stout));
    assert_eq!(change.shell.as_deref(), Some("#abcdef"));
    assert_eq!(change.eyes, Some(Eyes::Chevron));
    assert_eq!(change.antenna, Some(Antenna::Bare));
    assert_eq!(
        change.worn.get(&Slot::Head),
        Some(&Some("a_hat".to_string()))
    );
    assert_eq!(change.worn.get(&Slot::Neck), Some(&None));
    for (input, said) in [
        (json!({ "antenna": "bolt" }), "antenna \"bolt\" is not one of: ball, halo, crown, star, leaf, moon, twin, sun, spark, bar, sprout, none."),
        (json!({ "eyes": "wink" }), "eyes \"wink\""),
        (json!({ "glow": "blue" }), "glow must be #rrggbb"),
        (json!({ "worn": { "tail": "a_hat" } }), "\"tail\" is not a slot"),
        (json!({ "worn": { "head": "a_nothing" } }), "there is no asset a_nothing"),
        (json!({ "worn": { "neck": "a_hat" } }), "not an accessory for the neck slot"),
        (json!({ "worn": { "head": "a_desk" } }), "not an accessory for the head slot"),
        (json!({ "hat": "a_hat" }), "unknown field `hat`"),
    ] {
        let why = check_look(input.clone(), &island, &anyone).unwrap_err();
        assert!(why.contains(said), "{input}: {why}");
    }
    let why = check_look(json!({ "worn": { "head": "a_hat" } }), &island, &|_| false).unwrap_err();
    assert!(why.contains("not yours to wear"), "{why}");

    // Laid over an agent's patch, what it sets replaces and the rest stays;
    // null takes an accessory off.
    let mut patch = LookPatch {
        trim: Some("#111111".into()),
        ..Default::default()
    };
    patch.worn.insert(Slot::Neck, "a_scarf".into());
    change.apply_to_patch(&mut patch);
    assert_eq!(patch.trim.as_deref(), Some("#111111"));
    assert_eq!(patch.frame, Some(Frame::Stout));
    assert_eq!(
        patch.worn.get(&Slot::Head).map(String::as_str),
        Some("a_hat")
    );
    assert!(!patch.worn.contains_key(&Slot::Neck));
}

#[test]
fn shapes_seen_from_above_overlap_only_when_they_do() {
    let square = |x: f64, z: f64| vec![[x, z], [x + 1.0, z], [x + 1.0, z + 1.0], [x, z + 1.0]];
    assert!(overlaps(&square(0.0, 0.0), &square(0.5, 0.5)));
    // Touching is not overlapping.
    assert!(!overlaps(&square(0.0, 0.0), &square(1.0, 0.0)));
    assert!(!overlaps(&square(0.0, 0.0), &square(3.0, 0.0)));
    // A diamond near a square's corner, but clear of it.
    let diamond = vec![[2.0, 1.0], [2.6, 1.6], [2.0, 2.2], [1.4, 1.6]];
    assert!(!overlaps(&square(0.0, 0.0), &diamond));
    // The narrowest and the area of a turned box, seen from above.
    let wall = Part {
        shape: Shape::Round,
        size: [4.0, 1.8, 0.2],
        at: [0.0, 0.9, 0.0],
        turn: Some([0.0, 30.0, 0.0]),
        color: "#ffffff".into(),
        finish: None,
    };
    let seen = footprint(&wall);
    assert!((narrowest(&seen) - 0.2).abs() < 1e-9);
    assert!((area(&seen) - 0.8).abs() < 1e-9);
}

#[test]
fn every_starter_is_an_asset_the_host_would_take() {
    for agent in ["agent-1", "agent-2", "agent-3"] {
        let (wall, trim) = starter::agent_tint(agent);
        for made in [starter::workshop(&wall, &trim), starter::desk(&trim)] {
            check_asset(made.clone()).unwrap_or_else(|why| panic!("{}: {why}", made["name"]));
        }
    }
    let (workshop, _) = check_asset(starter::workshop("#ffffff", "#000000")).unwrap();
    let (desk, _) = check_asset(starter::desk("#000000")).unwrap();
    // What the contract says of them: a 5 × 4 m workshop with 1.8 m walls,
    // and a desk with a spot.
    let size = asset_bounds(&workshop.parts).size();
    assert_eq!(
        (workshop.kind, workshop.name.as_str()),
        (Kind::Building, "Workshop")
    );
    assert_eq!(desk.r#use, Some(Use::Desk));
    assert!(desk.spot.is_some());
    let walls = workshop
        .parts
        .iter()
        .filter(|p| p.shape == Shape::Round && p.size[1] >= 1.5)
        .map(|p| p.size[1])
        .fold(0.0, f64::max);
    assert_eq!(walls, 1.8);
    assert!((5.0..=5.3).contains(&size[0]) && (4.0..=5.0).contains(&size[2]));
    // Both stand on the tile where they are put, the desk inside the
    // workshop's walls, against its back wall.
    let (at, inside) = (starter::WORKSHOP_AT, starter::DESK_AT);
    let outer = asset_bounds(&workshop.parts);
    assert!(fits_plot(&outer, at.0, at.1, 0.0));
    let inner = asset_bounds(&desk.parts);
    assert!(fits_plot(&inner, inside.0, inside.1, 0.0));
    let (back_wall, side_wall) = (at.1 - 1.85, at.0 + 2.35);
    assert!(inside.1 + inner.min[2] > back_wall && inside.1 + inner.min[2] < back_wall + 0.1);
    assert!(inside.0 + inner.max[0] < side_wall && inside.0 + inner.min[0] > -side_wall);
}

#[test]
fn a_placement_keeps_every_corner_on_the_hexagonal_tile() {
    let bounds = Bounds {
        min: [-0.5, 0.0, -0.5],
        max: [0.5, 1.0, 0.5],
    };
    assert!(fits_plot(&bounds, 0.0, 0.0, 0.0));
    // Flat front and back at z = ±5.456.
    assert!(fits_plot(&bounds, 0.0, 4.956, 0.0));
    assert!(!fits_plot(&bounds, 0.0, 4.96, 0.0));
    // The pointed sides: room runs out sooner off the middle.
    assert!(fits_plot(&bounds, 5.5, 0.0, 0.0));
    assert!(!fits_plot(&bounds, 5.5, 0.5, 0.0));
    // Turned 45°, a square reaches further across.
    assert!(fits_plot(&bounds, 0.0, 4.75, 0.0));
    assert!(!fits_plot(&bounds, 0.0, 4.75, 45.0));
}
