import unittest

from scene_analysis import analyze_home, validate_home


def make_home(walls=None, rooms=None, furniture=None):
    return {
        "walls": walls or [],
        "rooms": rooms or [],
        "furniture": furniture or [],
        "levels": [], "polylines": [], "dimensionLines": [], "labels": [], "roofs": [],
    }


SQUARE_ROOM = {"id": "r1", "name": "Room", "points": [[0, 0], [400, 0], [400, 300], [0, 300]]}
CLOSED_SQUARE_WALLS = [
    {"id": "w1", "xStart": 0, "yStart": 0, "xEnd": 400, "yEnd": 0},
    {"id": "w2", "xStart": 400, "yStart": 0, "xEnd": 400, "yEnd": 300},
    {"id": "w3", "xStart": 400, "yStart": 300, "xEnd": 0, "yEnd": 300},
    {"id": "w4", "xStart": 0, "yStart": 300, "xEnd": 0, "yEnd": 0},
]


class SceneAnalysisTest(unittest.TestCase):
    def test_reports_room_area_and_outside_furniture(self):
        home = {
            "walls": [{"id": "w1", "xStart": 0, "yStart": 0, "xEnd": 400, "yEnd": 0}],
            "rooms": [{"id": "r1", "name": "Room", "points": [[0, 0], [400, 0], [400, 300], [0, 300]]}],
            "furniture": [{"id": "f1", "name": "Chair", "x": 100, "y": 100},
                          {"id": "f2", "name": "Lamp", "x": 900, "y": 900}],
            "levels": [], "polylines": [], "dimensionLines": [], "labels": [], "roofs": [],
        }
        summary = analyze_home(home)
        self.assertEqual(summary["rooms"][0]["areaSqM"], 12)
        self.assertEqual(summary["furniture"][0]["roomId"], "r1")
        self.assertIn("furniture f2 is outside every room", summary["warnings"])
        self.assertTrue(validate_home(home)["valid"])

    def test_duplicate_ids_warn_and_are_errors(self):
        home = make_home(
            walls=[CLOSED_SQUARE_WALLS[0], dict(CLOSED_SQUARE_WALLS[0])],
            rooms=[SQUARE_ROOM, dict(SQUARE_ROOM)],
            furniture=[{"id": "f1", "name": "Chair", "x": 100, "y": 100},
                       {"id": "f1", "name": "Lamp", "x": 200, "y": 100}],
        )
        summary = analyze_home(home)
        self.assertIn("duplicate wall id: w1", summary["warnings"])
        self.assertIn("duplicate room id: r1", summary["warnings"])
        self.assertIn("duplicate furniture id: f1", summary["warnings"])
        result = validate_home(home)
        self.assertFalse(result["valid"])
        for message in ("duplicate wall id: w1", "duplicate room id: r1", "duplicate furniture id: f1"):
            self.assertIn(message, result["errors"])

    def test_unique_ids_across_types_do_not_collide(self):
        home = make_home(
            walls=CLOSED_SQUARE_WALLS,
            rooms=[SQUARE_ROOM],
            furniture=[{"id": "w1", "name": "Chair", "x": 100, "y": 100}],
        )
        self.assertNotIn("duplicate wall id: w1", analyze_home(home)["warnings"])

    def test_self_intersecting_room_warns_and_is_error(self):
        bowtie = {"id": "r1", "name": "Bowtie", "points": [[0, 0], [400, 400], [400, 0], [0, 400]]}
        home = make_home(walls=CLOSED_SQUARE_WALLS, rooms=[bowtie])
        summary = analyze_home(home)
        self.assertIn("room r1 polygon is self-intersecting", summary["warnings"])
        result = validate_home(home)
        self.assertFalse(result["valid"])
        self.assertIn("room r1 polygon is self-intersecting", result["errors"])

    def test_overlapping_rooms_warn_but_stay_valid(self):
        overlap = {"id": "r2", "name": "Overlap", "points": [[200, 0], [600, 0], [600, 300], [200, 300]]}
        home = make_home(walls=CLOSED_SQUARE_WALLS, rooms=[SQUARE_ROOM, overlap])
        summary = analyze_home(home)
        self.assertIn("rooms r1 and r2 overlap", summary["warnings"])
        result = validate_home(home)
        self.assertTrue(result["valid"])
        self.assertNotIn("rooms r1 and r2 overlap", result["errors"])

    def test_adjacent_rooms_do_not_overlap(self):
        neighbor = {"id": "r2", "name": "Neighbor", "points": [[400, 0], [800, 0], [800, 300], [400, 300]]}
        home = make_home(walls=CLOSED_SQUARE_WALLS, rooms=[SQUARE_ROOM, neighbor])
        self.assertNotIn("rooms r1 and r2 overlap", analyze_home(home)["warnings"])

    def test_clean_scene_has_no_warnings(self):
        home = make_home(
            walls=CLOSED_SQUARE_WALLS,
            rooms=[SQUARE_ROOM],
            furniture=[{"id": "f1", "name": "Chair", "x": 100, "y": 100}],
        )
        summary = analyze_home(home)
        self.assertEqual(summary["warnings"], [])
        self.assertTrue(validate_home(home)["valid"])

    def _box(self, **item):
        piece = {"id": "f1", "name": "Sofa", "x": 200, "y": 150, "width": 120, "depth": 60, "angleDeg": 0}
        piece.update(item)
        walls = [dict(wall, thickness=10) for wall in CLOSED_SQUARE_WALLS]
        return make_home(walls=walls, rooms=[SQUARE_ROOM], furniture=[piece])

    def test_furniture_inside_a_wall_is_an_error(self):
        home = self._box(y=0)
        result = validate_home(home)
        self.assertIn("furniture f1 overlaps wall w1", result["warnings"])
        self.assertIn("furniture f1 overlaps wall w1", result["errors"])
        self.assertFalse(result["valid"])

    def test_rotated_furniture_poking_into_a_wall_is_an_error(self):
        self.assertFalse(validate_home(self._box(x=20, y=150, angleDeg=90, width=150, depth=40))["valid"])

    def test_furniture_flush_against_a_wall_face_is_valid(self):
        result = validate_home(self._box(y=35))
        self.assertTrue(result["valid"], result["errors"])

    def test_doors_and_windows_may_sit_in_walls(self):
        home = self._box(y=0, doorOrWindow=True, width=90, depth=10)
        self.assertTrue(validate_home(home)["valid"])

    def test_furniture_ignores_walls_on_other_levels(self):
        home = self._box(y=0, levelRef="level-2")
        self.assertTrue(validate_home(home)["valid"])

    def test_round_walls_are_solid_along_their_bulge(self):
        arc = {"id": "arc", "xStart": 0, "yStart": 0, "xEnd": 200, "yEnd": 0, "thickness": 10, "arcExtent": 3.14159}
        piece = {"id": "f1", "name": "Pot", "x": 100, "y": -100, "width": 30, "depth": 30, "angleDeg": 0}
        self.assertIn("furniture f1 overlaps wall arc", analyze_home(make_home(walls=[arc], furniture=[piece]))["warnings"])
        piece["y"] = 100
        self.assertNotIn("furniture f1 overlaps wall arc", analyze_home(make_home(walls=[arc], furniture=[piece]))["warnings"])

    def test_round_wall_clearance_is_tight_to_the_true_arc(self):
        # Chord approximation used to leave a visible gap or cut in; slices stand off by <= 0.005 cm.
        arc = {"id": "arc", "xStart": -100, "yStart": 0, "xEnd": 100, "yEnd": 0, "thickness": 10, "arcExtent": 3.14159265}
        # True outer face of the semicircle bulge is radius 105 around (0, 0) (bulge toward -y).
        def overlaps(y):
            piece = {"id": "f1", "name": "Pot", "x": 0, "y": y, "width": 20, "depth": 20, "angleDeg": 0}
            return "furniture f1 overlaps wall arc" in analyze_home(make_home(walls=[arc], furniture=[piece]))["warnings"]
        self.assertTrue(overlaps(-104))
        self.assertFalse(overlaps(-105 - 10 - 0.01))
        self.assertTrue(overlaps(-105 - 10 + 0.5))

    def test_oversize_furniture_in_a_room_is_an_error_with_the_app_wording(self):
        result = validate_home(self._box(width=500, depth=60))
        message = '"Sofa" (500 x 60 cm) is too large for room "Room" (about 400 x 300 cm): it cannot fit inside the room\'s walls.'
        self.assertIn(message, result["errors"])
        self.assertFalse(result["valid"])

    def test_exact_fit_is_not_oversize(self):
        # Room interior is 390 cm wide (400 minus two 5 cm half-walls).
        self.assertFalse(any("too large" in w for w in validate_home(self._box(width=390, depth=60))["warnings"]))
        self.assertTrue(any("too large" in w for w in validate_home(self._box(width=391, depth=60))["warnings"]))

    def test_oversize_piece_outside_any_room_is_not_flagged_as_too_large(self):
        home = self._box(x=900, y=900, width=500, depth=60)
        self.assertFalse(any("too large" in w for w in validate_home(home)["warnings"]))

    def test_unnamed_room_is_named_by_id(self):
        home = self._box(width=500, depth=60)
        home["rooms"] = [{"id": "r1", "points": SQUARE_ROOM["points"]}]
        self.assertTrue(any("too large for room r1 " in e for e in validate_home(home)["errors"]))

    def test_piece_that_fits_a_bowed_room_is_not_flagged_too_large(self):
        # Regression: pushing slice by slice around a bulging arc wall reported this
        # overlapping piece as too large although it fits (the app, which pushes
        # analytically, accepts it). A piece must only be called too large when it
        # truly cannot fit, so an overlap here is reported as an overlap only.
        bow = {"id": "w2", "xStart": 572.88, "yStart": 0, "xEnd": 572.88, "yEnd": 594.93, "thickness": 14.83, "arcExtent": -2.18}
        straight = [{"id": f"w{i}", "xStart": a[0], "yStart": a[1], "xEnd": b[0], "yEnd": b[1], "thickness": 14.83}
                    for i, (a, b) in ((1, ((0, 0), (572.88, 0))), (3, ((572.88, 594.93), (0, 594.93))), (4, ((0, 594.93), (0, 0))))]
        home = {"walls": [straight[0], bow, *straight[1:], {"id": "p", "xStart": 286.44, "yStart": 0, "xEnd": 286.44, "yEnd": 356.958, "thickness": 9.37}],
                "rooms": [{"id": "r", "name": "Bow", "points": [[0, 0], [572.88, 0], [572.88, 594.93], [0, 594.93]]}],
                "furniture": [{"id": "f", "name": "Bench", "x": 135.84, "y": 307.11, "angleDeg": -67, "width": 388.17, "depth": 178.02, "height": 80, "elevation": 0}]}
        warnings = analyze_home(home)["warnings"]
        self.assertFalse(any("too large" in w for w in warnings), warnings)
        self.assertIn("furniture f overlaps wall w4", warnings)

    def test_furniture_hung_above_the_wall_top_does_not_overlap_it(self):
        home = self._box(x=200, y=0, width=100, depth=40)
        home["furniture"][0]["elevation"] = 250
        self.assertFalse(any("overlaps wall" in w for w in validate_home(home)["warnings"]))
        home["furniture"][0]["elevation"] = 249
        self.assertTrue(any("overlaps wall" in w for w in validate_home(home)["warnings"]))


if __name__ == "__main__":
    unittest.main()
