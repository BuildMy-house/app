"""The Python clearance port must reach the same verdicts as the app's TypeScript.

tests/fixtures/furniture-clearance-corpus.json holds rooms, straight and round
walls and furniture together with the verdicts computed by the TS store
(`npm run clearance:corpus`). src/core/furniture-clearance-parity.test.ts checks
the TS side against the same file, so both languages are pinned to one answer.
"""

import json
import pathlib
import unittest

from furniture_clearance import FurnitureTooLargeError, enforce_clearance, find_clearance_violations

CORPUS = json.loads((pathlib.Path(__file__).parent.parent / "tests" / "fixtures" / "furniture-clearance-corpus.json").read_text())


class ClearanceParityTest(unittest.TestCase):
    def test_corpus_is_substantial(self):
        self.assertGreater(len(CORPUS["cases"]), 150)

    def test_every_case_matches_the_app(self):
        mismatches = []
        for case in CORPUS["cases"]:
            found = find_clearance_violations(case["home"])
            overlaps = sorted([item["furnitureId"], item["wallId"]] for item in found["overlaps"])
            oversize = sorted(item["furnitureId"] for item in found["oversize"])
            if overlaps != case["expected"]["overlaps"] or oversize != case["expected"]["oversize"]:
                mismatches.append((case["name"], overlaps, oversize, case["expected"]))
        self.assertEqual(mismatches, [], f"{len(mismatches)} cases differ from the TS verdicts")

    def test_pieces_end_up_where_the_app_puts_them(self):
        mismatches = []
        for case in CORPUS["cases"]:
            for item in case["home"]["furniture"]:
                draft = {**case["home"], "furniture": [dict(item)]}
                previous = {**case["home"], "furniture": []}
                try:
                    enforce_clearance(draft, previous)
                    resolved = [draft["furniture"][0]["x"], draft["furniture"][0]["y"]]
                except FurnitureTooLargeError:
                    resolved = None
                expected = case["expected"]["resolved"][item["id"]]
                same = resolved is None if expected is None else (
                    resolved is not None and abs(resolved[0] - expected[0]) < 1e-5 and abs(resolved[1] - expected[1]) < 1e-5)
                if not same:
                    mismatches.append((case["name"], item["id"], resolved, expected))
        self.assertEqual(mismatches, [], f"{len(mismatches)} pieces end up elsewhere than in the app")


if __name__ == "__main__":
    unittest.main()
