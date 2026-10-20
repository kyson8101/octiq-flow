//! The building guide `island_look` answers with: everything an agent needs
//! to build well, in one read. It is the host's, so it says the same numbers
//! `rules.rs` checks, and a test holds it to them and to its length (an
//! agent pays for every character of it, once per build).

/// The worked example, which a test builds through the same checks as an
/// agent's asset.
pub const EXAMPLE: &str = r##"{"name":"Mushroom stool","kind":"furniture","use":"seat","spot":{"at":[0,0.38,0],"face":0},"parts":[{"shape":"cylinder","size":[0.2,0.3,0.2],"at":[0,0.15,0],"color":"#f3e9d2"},{"shape":"sphere","size":[0.46,0.16,0.46],"at":[0,0.3,0],"color":"#e76f51"},{"shape":"sphere","size":[0.08,0.03,0.08],"at":[0.1,0.37,0.08],"color":"#ffffff"}]}"##;

pub fn text() -> String {
    format!(
        r##"# Building for the island

Everything on the island is built from simple shapes. Units are metres and +y is up. An asset's origin is the centre of its footprint on the ground, and its front faces +z. A robot faces +z too; +x is on its left.

## Robots
Everyone on the island is a chibi robot: the person's registered agents, and the 波特 who live there. Every 波特 wears a backpack it designed itself; a back accessory you give it replaces that one. A robot is 1.0 m tall to the top of its head (its antenna is above that). Its head is about 0.8 m wide, 0.57 m tall and 0.48 m deep; its body is small; sitting, its hips are about 0.2 m up. For robots, a seat is 0.2-0.4 m high, a desk 0.45-0.6 m, a door at least 1.0 m wide and 1.4 m tall, walls 1.6-2.4 m.
Accessory anchors (an accessory's coordinates start there): head = top centre of the head (1.0 m up); face = front of the visor (0.70 m up, 0.29 m forward); neck = where head meets body (0.42 m up); back = middle of the back (0.30 m up, 0.08 m behind); hand = palm of the right hand (the -x side), which moves with the arm.

## Parts
An asset is a list of parts, each one shape scaled to a box:
{{"shape", "size": [x,y,z], "at": [x,y,z] (the box's centre), "turn": [x,y,z] degrees (optional, applied x then y then z about the centre), "color": "#rrggbb", "finish" (optional)}}
Shapes: box; round (a box with soft edges); cylinder (x, z diameters, y height); cone (point up); sphere (x, y, z diameters); torus (a flat ring: x, z outer diameters, y the tube); wedge (full height at -z, sloping to nothing at +z).
Finishes: matte, soft (default), shiny, metal, glass (see-through), glow (lit from inside).
Each size is at least 0.02 m. Numbers are kept to the millimetre.

## Kinds (every part's box, after its turn, stays within)
- accessory: 1-40 parts, a slot (head, face, neck, back, hand); x, z ±0.6 of the anchor; y -0.6 to 0.9.
- furniture: 1-60 parts; x, z ±1.5; y 0 to 2.5.
- decor: 1-80 parts; x, z ±2; y 0 to 5.
- building: 1-200 parts; x, z ±5; y 0 to 3.
A part may sink 5 cm into the ground (y down to -0.05), except an accessory's.
Furniture and decor may have a use: seat, desk, bed or none. With a use, a spot says where a robot sits (seat, bed: its hips) or stands (desk: its feet, facing the desk): {{"at": [x,y,z], "face": degrees}}, 0 facing +z, 90 facing +x.

## Buildings have no roof
The person must always be able to watch inside, so a building is refused when:
1. a part whose top is above 1.2 m is more than 0.5 m thick both ways seen from above. Walls, posts, beams and door frames are thin one way; a slab, a solid block or a sloped roof is not.
2. the parts wholly above 1.5 m (beams, lintels, signs, lamps) cover more than 15% of the building's floor, the x by z area of its bounding box.
Floors are fine. Leave a doorway, and put furniture in as separate assets.

## Plots
A plot is a hexagonal tile, 6.3 m from its centre to a corner. In plot coordinates the origin is its centre and +z faces the plaza: the front edge is flat at z = +5.456, the back edge flat at z = -5.456, and the sides come to points at x = ±6.3. A point is on the tile when |z| ≤ 5.456 and |x| + |z|/√3 ≤ 6.3. A placement is {{x, z, y (0 to 1.2, to stand on a table), turn (degrees about y)}}; every corner of the asset's box after the turn stays on the tile. A plot holds at most 40 placements and 1,500 parts between them. Furniture, decor and buildings are placed; accessories are worn.

## 波特 homes
波特 live together, up to four to a home on one plot. The house belongs to all of them: they built it together, each has a bed along its back wall and one touch of its own (a flower box, a workbench, an easel). A present for a 波特 goes on its home's plot; a building replaces the house, and the beds and touches stay.

## Tools
island_build makes an asset (pass assetId to rebuild one you made). island_grant gives an open wish its present: an accessory is worn in its slot, furniture and decor are placed where there is room (or at the x, z you give), a building replaces the robot's building, and a look wish takes a look instead of an asset. A registered agent also styles its own robot with island_style and arranges its own plot with island_place.

## Example: a stool
{EXAMPLE}

## Style
Cute and chunky: round shapes over sharp ones, soft finishes, 2 to 4 colours, thick proportions and one or two small details. Keep things robot-sized. A few bold parts read better than many tiny ones."##
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guide_is_short_enough_to_read_once_per_build() {
        let guide = text();
        assert!(guide.chars().count() <= 5000, "{}", guide.chars().count());
        for kept in [
            "1.0 m tall",
            "0.70 m up, 0.29 m forward",
            "more than 0.5 m thick both ways",
            "more than 15%",
            "hexagonal tile",
            "flat at z = +5.456",
            "points at x = ±6.3",
            "|x| + |z|/√3 ≤ 6.3",
            "40 placements and 1,500 parts",
            "island_build",
            "island_grant",
            "island_style",
            "island_place",
        ] {
            assert!(guide.contains(kept), "{kept}");
        }
    }

    #[test]
    fn the_example_is_an_asset_the_host_takes() {
        let (draft, _) =
            crate::island::rules::check_asset(serde_json::from_str(EXAMPLE).unwrap()).unwrap();
        assert_eq!(draft.parts.len(), 3);
        assert!(text().contains(EXAMPLE));
    }
}
