import unittest
import json
import tempfile

import gps_tracker


class DeviceDiscoveryTests(unittest.TestCase):
    def test_single_device_is_automatic(self):
        devices = [{"port": "/dev/rocket", "description": "Radio"}]
        self.assertEqual(gps_tracker.choose_device(devices, interactive=False), "/dev/rocket")

    def test_multiple_devices_require_clarification_without_terminal(self):
        devices = [
            {"port": "/dev/one", "description": "One"},
            {"port": "/dev/two", "description": "Two"},
        ]
        with self.assertRaisesRegex(RuntimeError, "Multiple serial devices"):
            gps_tracker.choose_device(devices, interactive=False)

    def test_interactive_device_choice(self):
        devices = [
            {"port": "/dev/one", "description": "One"},
            {"port": "/dev/two", "description": "Two"},
        ]
        chosen = gps_tracker.choose_device(devices, input_fn=lambda _: "2", interactive=True)
        self.assertEqual(chosen, "/dev/two")


class FlightTests(unittest.TestCase):
    def test_parser_accepts_telemetry_with_or_without_timestamp(self):
        tracker = gps_tracker.GPSTracker(log_path=None)
        with_timestamp = (
            "19:02:56.588 > 0, 00000000100000000000000000000000, "
            "55.870758, -4.286921, -1684.13, -31, 9"
        )
        without_timestamp = (
            "0, 00000000100000000000000000000000, "
            "55.870758, -4.286921, -1684.13, -31, 9"
        )

        self.assertTrue(tracker._parse_line(with_timestamp))
        self.assertTrue(tracker._parse_line(without_timestamp))
        points = tracker.snapshot()["points"]
        self.assertEqual(points[0]["time"], "19:02:56.588")
        self.assertEqual(points[0]["stage"], 0)
        self.assertAlmostEqual(points[1]["lat"], 55.870758)

    def test_parser_rejects_invalid_fix(self):
        tracker = gps_tracker.GPSTracker(log_path=None)
        self.assertFalse(tracker._parse_line("12:00:00.000 > 1, 0, 0, 0, 10, -50, 5"))

    def test_parser_recovers_after_a_broken_packet_on_the_same_line(self):
        tracker = gps_tracker.GPSTracker(log_path=None)
        broken_then_valid = (
            "12:00:00.000 > 1, broken packet"
            "12:00:01.000 > 1, 00000002, 55.870758, -4.286921, 120.5, -72, 9"
        )

        self.assertTrue(tracker._parse_line(broken_then_valid))
        self.assertEqual(len(tracker.snapshot()["points"]), 1)
        self.assertEqual(tracker.snapshot()["points"][0]["time"], "12:00:01.000")

    def test_parser_recovers_concatenated_packets_without_timestamps(self):
        tracker = gps_tracker.GPSTracker(log_path=None)
        concatenated = (
            "0, 00000001, 55.870758, -4.286921, 45.0, -70, 9"
            "1, 00000002, 55.870858, -4.286821, 65.0, -71, 10"
        )

        self.assertTrue(tracker._parse_line(concatenated))
        self.assertEqual(len(tracker.snapshot()["points"]), 2)
        self.assertEqual(tracker.snapshot()["points"][1]["stage"], 1)

    def test_rejected_packet_is_logged_and_next_packet_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/backup.jsonl"
            tracker = gps_tracker.GPSTracker(log_path=path)
            self.assertFalse(tracker._parse_line("corrupt packet"))
            self.assertTrue(tracker._parse_line(
                "1, 00000002, 55.870758, -4.286921, 120.5, -72, 9"
            ))
            tracker.close_log()
            with open(path, encoding="utf-8") as backup:
                records = [json.loads(line) for line in backup]
            self.assertEqual([record["record"] for record in records], ["rejected", "telemetry"])

    def test_simulated_ascent_detects_launch_and_predicts_3d_path(self):
        tracker = gps_tracker.GPSTracker(log_path=None)
        for second, altitude in enumerate((45, 45, 47, 62, 90, 125)):
            lat, lon = gps_tracker.offset_location(55.87, -4.29, second * 2, second * 3)
            tracker.add_point(lat, lon, altitude, timestamp=f"12:00:{second:02d}.000", elapsed=second)
        snapshot = tracker.snapshot()
        self.assertTrue(snapshot["flight"]["launched"])
        self.assertGreater(snapshot["flight"]["velocity"]["vertical"], 5)
        self.assertGreater(len(snapshot["prediction"]), 1)
        self.assertGreater(snapshot["prediction"][0]["alt"], snapshot["points"][-1]["alt"])
        self.assertNotEqual(snapshot["prediction"][0]["lon"], snapshot["points"][-1]["lon"])

    def test_midnight_rollover_still_computes_velocity(self):
        tracker = gps_tracker.GPSTracker(log_path=None)
        tracker.add_point(55.87, -4.29, 45, timestamp="23:59:59.000")
        tracker.add_point(55.87, -4.29, 55, timestamp="00:00:00.000")
        self.assertAlmostEqual(tracker.snapshot()["flight"]["velocity"]["vertical"], 10)

    def test_every_point_is_durably_written_to_jsonl_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/backup.jsonl"
            tracker = gps_tracker.GPSTracker(log_path=path)
            tracker.add_point(55.87, -4.29, 45, timestamp="12:00:00.000", elapsed=0)
            tracker.add_point(55.8701, -4.2899, 55, timestamp="12:00:01.000", elapsed=1)
            tracker.close_log()
            with open(path, encoding="utf-8") as backup:
                records = [json.loads(line) for line in backup]
            self.assertEqual(len(records), 2)
            self.assertEqual(records[0]["record"], "telemetry")
            self.assertEqual(records[1]["point"]["alt"], 55.0)


class MapTests(unittest.TestCase):
    def test_local_env_parser_accepts_comments_and_quotes(self):
        from tempfile import NamedTemporaryFile

        with NamedTemporaryFile(mode="w+", suffix=".env") as env_file:
            env_file.write("# local credentials\nCESIUM_ION_TOKEN='abc.def'\nIGNORED\n")
            env_file.flush()
            self.assertEqual(
                gps_tracker.load_local_env(env_file.name)["CESIUM_ION_TOKEN"], "abc.def"
            )

    def test_terrain_token_is_injected_at_runtime(self):
        page = gps_tracker.render_map_page("test-public-token")
        self.assertIn('const CESIUM_TOKEN="test-public-token"', page)
        self.assertNotIn("__CESIUM_TOKEN__", page)

    def test_missing_token_keeps_flat_terrain_fallback(self):
        page = gps_tracker.render_map_page()
        self.assertIn('const CESIUM_TOKEN=""', page)
        self.assertIn("FLAT TERRAIN", page)

    def test_map_uses_browser_geolocation_for_a_device_marker(self):
        page = gps_tracker.render_map_page()
        self.assertIn("navigator.geolocation.watchPosition", page)
        self.assertIn("DEVICE GPS", page)
        self.assertIn("locationAccuracy", page)


if __name__ == "__main__":
    unittest.main()
