import unittest

import server


class FakeSession:
    def __init__(self):
        self.calls = []
        self.next_id = 1

    async def request(self, command, params=None):
        self.calls.append((command, params or {}))
        if command == "new_home":
            return {}
        if command == "get_state":
            return {"levels": [], "walls": [], "rooms": [], "furniture": [], "roofs": []}
        result = {"id": f"{command}-{self.next_id}"}
        self.next_id += 1
        return result


class BuildHouseTest(unittest.IsolatedAsyncioTestCase):
    async def test_build_house_preserves_advanced_refs_and_returns_ids(self):
        fake = FakeSession()
        original = server._session
        server._session = lambda: fake
        try:
            result = await server.build_house({
                "levels": [{"key": "upper", "name": "Upper", "elevation": 280, "visible": False}],
                "rooms": [{"key": "studio", "levelKey": "upper", "name": "Studio",
                           "points": [[0, 0], [400, 0], [400, 300], [0, 300]]}],
                "furniture": [{"key": "desk", "levelKey": "upper", "name": "Desk",
                               "x": 100, "y": 100, "width": 120, "depth": 60, "height": 75}],
                "polylines": [{"key": "outline", "levelKey": "upper",
                               "points": [[0, 0], [400, 0]], "closed": False}],
                "labels": [{"key": "label", "levelKey": "upper", "x": 10, "y": 10,
                            "text": "Studio", "angleDeg": 15}],
                "dimensions": [{"key": "dimension", "levelKey": "upper", "xStart": 0,
                                "yStart": 0, "xEnd": 400, "yEnd": 0, "offset": -30}],
            })
        finally:
            server._session = original

        self.assertEqual(result["levelIds"], {"upper": "add_level-1"})
        self.assertEqual(result["wallIds"]["studio-wall-1"], "add_wall-2")
        self.assertEqual(result["roomIds"], {"studio": "add_room-6"})
        self.assertEqual(result["furnitureIds"], {"desk": "add_furniture-7"})
        self.assertEqual(result["polylineIds"], {"outline": "add_polyline-8"})
        self.assertEqual(result["labelIds"], {"label": "add_label-9"})
        self.assertEqual(result["dimensionIds"], {"dimension": "add_dimension_line-10"})

        room_call = next(params for command, params in fake.calls if command == "add_room")
        self.assertEqual(room_call["levelRef"], "add_level-1")
        label_call = next(params for command, params in fake.calls if command == "add_label")
        self.assertEqual(label_call["angleDeg"], 15)

    async def test_unknown_level_key_fails_before_drawing(self):
        fake = FakeSession()
        original = server._session
        server._session = lambda: fake
        try:
            with self.assertRaisesRegex(ValueError, "unknown levelKey: upper"):
                await server.build_house({
                    "levels": [],
                    "rooms": [{"levelKey": "upper", "points": [[0, 0], [1, 0], [1, 1]]}],
                })
        finally:
            server._session = original

        self.assertEqual([command for command, _ in fake.calls], ["new_home"])


if __name__ == "__main__":
    unittest.main()
