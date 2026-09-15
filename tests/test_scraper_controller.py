import unittest

from app.scraper.controller import ScraperController


class ScraperControllerTests(unittest.TestCase):
    def setUp(self):
        self.controller = ScraperController(object())

    def test_status_starts_with_login_required(self):
        status = self.controller.status()
        self.assertEqual(status["state"], "login_required")
        self.assertFalse(status["ready_for_scrape"])
        self.assertEqual(len(status["steps"]), 3)

    def test_rejects_unknown_mode(self):
        with self.assertRaises(ValueError):
            self.controller.start("unknown")

    def test_rejects_second_run_while_scraping(self):
        self.controller._status["state"] = "scraping"
        with self.assertRaises(RuntimeError):
            self.controller.start("scrape")

    def test_progress_accumulates_saved_jobs(self):
        self.controller._status["run_id"] = "run-1"
        self.controller._progress("run-1", pages_completed=1, jobs_saved=3, message="page one")
        self.controller._progress("run-1", pages_completed=2, jobs_saved=4, message="page two")
        status = self.controller.status()
        self.assertEqual(status["pages_completed"], 2)
        self.assertEqual(status["jobs_saved"], 7)


if __name__ == "__main__":
    unittest.main()