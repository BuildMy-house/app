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


if __name__ == "__main__":
    unittest.main()
