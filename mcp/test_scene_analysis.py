import unittest

from scene_analysis import analyze_home, validate_home


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


if __name__ == "__main__":
    unittest.main()
