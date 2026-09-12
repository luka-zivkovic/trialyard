import unittest
from inspect_ai.scorer import Score, SampleScore
from offline_spike import judgment_counts

class CategoryCounts(unittest.TestCase):
    def test_missing_and_failed_assessment_are_separate_from_behavior(self):
        values = ['not_evaluable', 'satisfied', 'assessment_error', 'violated', 'not_applicable']
        scores = [SampleScore(score=Score(value=v), sample_id=i) for i, v in enumerate(values)]
        counts = judgment_counts()(scores)
        self.assertEqual(counts['total'], 5)
        self.assertEqual(counts['evaluable'], 2)
        for value in values: self.assertEqual(counts[value], 1)
        self.assertEqual(judgment_counts()(list(reversed(scores))), counts)

if __name__ == '__main__': unittest.main()
