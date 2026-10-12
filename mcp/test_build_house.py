import json
import unittest

import server
from automation_server import AdapterError


class FakeSession:
    def __init__(self):
        self.calls = []
        self.next_id = 1

    async def request(self, command, params=None):
        self.calls.append((command, params or {}))
        if command in ("new_home", "begin_batch", "end_batch"):
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

        # The reset is inside the batch and rolled back, so the failed build changed nothing.
        self.assertEqual(fake.calls, [("begin_batch", {}), ("new_home", {}), ("end_batch", {"commit": False})])

    async def test_rejected_piece_rolls_the_whole_build_back(self):
        class RejectingSession(FakeSession):
            async def request(self, command, params=None):
                if command == "add_furniture":
                    self.calls.append((command, params or {}))
                    raise AdapterError('"Sofa" (500 x 90 cm) is too large for room "Living"', "FURNITURE_TOO_LARGE")
                return await super().request(command, params)

        fake = RejectingSession()
        original = server._session
        server._session = lambda: fake
        try:
            with self.assertRaisesRegex(AdapterError, "FURNITURE_TOO_LARGE"):
                await server.build_house({
                    "rooms": [{"points": [[0, 0], [400, 0], [400, 400], [0, 400]], "name": "Living"}],
                    "furniture": [{"name": "Sofa", "x": 200, "y": 200, "width": 500, "depth": 90, "height": 80}],
                })
        finally:
            server._session = original

        self.assertEqual(fake.calls[0][0], "begin_batch")
        self.assertEqual(fake.calls[-1], ("end_batch", {"commit": False}))
        self.assertNotIn(("end_batch", {"commit": True}), fake.calls)

    async def test_successful_build_commits_the_batch(self):
        fake = FakeSession()
        original = server._session
        server._session = lambda: fake
        try:
            await server.build_house({"rooms": [{"points": [[0, 0], [400, 0], [400, 400], [0, 400]]}]})
        finally:
            server._session = original
        self.assertEqual(fake.calls[0][0], "begin_batch")
        self.assertEqual(fake.calls[-1], ("end_batch", {"commit": True}))

    async def test_list_furniture_threads_optional_filters(self):
        fake = FakeSession()
        original = server._session
        server._session = lambda: fake
        try:
            await server.list_furniture()
            await server.list_furniture(query="sofa", category="Living", limit=5)
            await server.list_furniture(query="door")
        finally:
            server._session = original

        self.assertEqual(fake.calls[0], ("list_catalog", {}))
        self.assertEqual(
            fake.calls[1],
            ("list_catalog", {"query": "sofa", "category": "Living", "limit": 5}),
        )
        self.assertEqual(fake.calls[2], ("list_catalog", {"query": "door"}))

    async def test_select_object_maps_single_and_batch_params(self):
        fake = FakeSession()
        original = server._session
        server._session = lambda: fake
        try:
            await server.select_object(object_id="furniture-1")
            await server.select_object(object_ids=["furniture-1", "furniture-2"])
            with self.assertRaisesRegex(ValueError, "object_id or object_ids"):
                await server.select_object()
        finally:
            server._session = original

        self.assertEqual(
            fake.calls,
            [
                ("select_object", {"objectId": "furniture-1"}),
                ("select_object", {"objectIds": ["furniture-1", "furniture-2"]}),
            ],
        )


_CORNERS = [[0, 0], [400, 0], [400, 400], [0, 400]]
WALLS = [{"key": f"living-wall-{i + 1}", "xStart": a[0], "yStart": a[1], "xEnd": b[0], "yEnd": b[1], "thickness": 10}
         for i, (a, b) in enumerate(zip(_CORNERS, _CORNERS[1:] + _CORNERS[:1]))]
ROOM = {"key": "living", "name": "Living", "points": _CORNERS}


class ProductionBuildHouseTest(unittest.IsolatedAsyncioTestCase):
    """build_house(house_id=...) writes straight to the server API, so it has to enforce
    the app's furniture rules itself (the app never sees these edits)."""

    def setUp(self):
        self.requests = []
        self.stored = {"name": "House", "json": json.dumps(server._empty_home()), "updatedAt": "t1"}
        self.saved = {key: getattr(server, key) for key in ("_API_URL", "_API_TOKEN", "_api_request")}
        server._API_URL, server._API_TOKEN = "http://api.test", "token"
        server._api_request = self.fake_api

    def tearDown(self):
        for key, value in self.saved.items():
            setattr(server, key, value)
        server._ACTIVE_HOUSES.clear()

    async def fake_api(self, path, method="GET", body=None):
        self.requests.append((method, path, body))
        if method == "PUT":
            return {"updatedAt": "t2"}
        return self.stored

    def writes(self):
        return [request for request in self.requests if request[0] == "PUT"]

    async def test_oversize_piece_rejects_the_build_before_anything_is_written(self):
        with self.assertRaisesRegex(AdapterError, r'FURNITURE_TOO_LARGE: "Sofa" \(500 x 90 cm\) is too large for room "Living"') as caught:
            await server.build_house({"walls": WALLS, "rooms": [ROOM], "furniture": [
                {"name": "Sofa", "x": 200, "y": 200, "width": 500, "depth": 90, "height": 80}]}, house_id="h1")
        self.assertEqual(caught.exception.code, "FURNITURE_TOO_LARGE")
        self.assertEqual(self.writes(), [])

    async def test_piece_overlapping_a_wall_is_moved_flush_like_the_app_does(self):
        result = await server.build_house({"walls": WALLS, "rooms": [ROOM], "furniture": [
            {"key": "desk", "name": "Desk", "x": 200, "y": 2, "width": 120, "depth": 60, "height": 75}]}, house_id="h1")
        written = json.loads(self.writes()[0][2]["json"])
        # Wall centreline y=0, 10 cm thick: the 60 cm deep desk rests at 5 + 30.
        self.assertEqual(written["furniture"][0]["y"], 35)
        desk = result["furnitureIds"]["desk"]
        self.assertEqual(result["adjustments"], [{"furnitureId": desk, "fromX": 200, "fromY": 2, "x": 200, "y": 35}])

    async def test_pieces_that_fit_are_untouched_and_openings_are_exempt(self):
        result = await server.build_house({"walls": WALLS, "rooms": [ROOM], "doors": [{"wallKey": "living-wall-1", "x": 200}], "furniture": [
            {"name": "Desk", "x": 200, "y": 200, "width": 120, "depth": 60, "height": 75}]}, house_id="h1")
        self.assertEqual(result["adjustments"], [])
        self.assertEqual(len(self.writes()), 1)

    async def test_piece_hung_above_the_wall_top_is_not_pushed(self):
        result = await server.build_house({"walls": WALLS, "rooms": [ROOM], "furniture": [
            {"name": "Banner", "x": 200, "y": 0, "width": 120, "depth": 10, "height": 40, "elevation": 260}]}, house_id="h1")
        self.assertEqual(result["adjustments"], [])

    async def test_unchanged_legacy_furniture_in_the_stored_house_is_left_alone(self):
        await server.build_house({"walls": WALLS, "rooms": [ROOM], "furniture": [
            {"name": "Desk", "x": 200, "y": 2, "width": 120, "depth": 60, "height": 75}]}, house_id="h1")
        self.stored["json"] = self.writes()[0][2]["json"]
        legacy = json.loads(self.stored["json"])
        legacy["furniture"][0]["y"] = 2  # a stored house that already clips a wall
        self.stored["json"] = json.dumps(legacy)
        self.requests.clear()
        result = await server.build_house({"labels": [{"x": 1, "y": 1, "text": "hi"}]}, reset=False, house_id="h1")
        self.assertEqual(result["adjustments"], [])
        self.assertEqual(json.loads(self.writes()[0][2]["json"])["furniture"][0]["y"], 2)

    async def test_new_wall_pushes_existing_furniture_out_like_a_wall_edit(self):
        first = await server.build_house({"walls": WALLS, "rooms": [ROOM], "furniture": [
            {"key": "desk", "name": "Desk", "x": 200, "y": 200, "width": 120, "depth": 60, "height": 75}]}, house_id="h1")
        self.stored["json"] = self.writes()[0][2]["json"]
        self.requests.clear()
        result = await server.build_house({"walls": [{"xStart": 100, "yStart": 200, "xEnd": 300, "yEnd": 200, "thickness": 10}]},
                                          reset=False, house_id="h1")
        self.assertEqual(len(result["adjustments"]), 1)
        self.assertEqual(result["adjustments"][0]["furnitureId"], first["furnitureIds"]["desk"])


if __name__ == "__main__":
    unittest.main()
