"""The Python clearance port must reach the same verdicts as the app's TypeScript.

tests/fixtures/furniture-clearance-corpus.json holds rooms, straight and round
walls and furniture together with the verdicts computed by the TS store
(`npm run clearance:corpus`). src/core/furniture-clearance-parity.test.ts checks
the TS side against the same file, so both languages are pinned to one answer.
"""

import json
import pathlib
import unittest

from furniture_clearance import find_clearance_violations

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


if __name__ == "__main__":
    unittest.main()
