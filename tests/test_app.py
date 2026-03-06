import unittest

from app import app


class TestAppRoutes(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_index_serves_html(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Custom Tracker AR', response.data)

    def test_status_reports_custom_tracker_mode(self):
        response = self.client.get('/status')
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn('ready', payload)
        self.assertEqual(payload['tracking_mode'], 'custom-server-cv-tracker')
        self.assertTrue(payload['server_tracking'])
        self.assertIn('camera-permission-required', payload['features'])
        self.assertIn('socketio-frame-stream', payload['features'])
        self.assertIn('solvepnp-pose-estimation', payload['features'])

    def test_favicon_is_empty(self):
        response = self.client.get('/favicon.ico')
        self.assertEqual(response.status_code, 204)


if __name__ == '__main__':
    unittest.main()
