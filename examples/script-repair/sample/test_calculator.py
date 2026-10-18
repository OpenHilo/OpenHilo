"""Fixed regression suite. The AI may edit calculator.py, not this file."""
import json
import sys
import unittest
from calculator import average


class AverageTests(unittest.TestCase):
    def test_whole_numbers(self):
        self.assertEqual(average([2, 4, 6]), 4)

    def test_fractional_result(self):
        self.assertEqual(average([1, 2]), 1.5)

    def test_negative_result(self):
        self.assertEqual(average([-2, -1]), -1.5)

    def test_single_decimal(self):
        self.assertEqual(average([2.5]), 2.5)

    def test_does_not_change_input(self):
        values = [3, 1, 2]
        self.assertEqual(average(values), 2)
        self.assertEqual(values, [3, 1, 2])

    def test_empty_input(self):
        with self.assertRaises(ValueError):
            average([])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(AverageTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({"suite": "average", "testsRun": result.testsRun, "successful": result.wasSuccessful()}))
    sys.exit(0 if result.wasSuccessful() else 1)
