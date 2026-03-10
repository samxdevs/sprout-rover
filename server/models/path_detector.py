"""
Path Detector for Rover Navigation
====================================
Combines OpenCV-based visual path detection with
waypoint-based path planning for autonomous rover navigation.

Usage:
    detector = PathDetector()
    result = detector.detect_from_image(frame)
    path = detector.plan_path(waypoints, obstacles)
"""

import math
import logging
import numpy as np

logger = logging.getLogger('sprout-server')


class PathDetector:
    """Computer vision + algorithmic path detection for rover navigation."""

    def __init__(self):
        self.cv2 = None
        try:
            import cv2
            self.cv2 = cv2
            logger.info("✅ PathDetector initialized with OpenCV")
        except ImportError:
            logger.warning("⚠️  OpenCV not available. Path detection in mock mode.")

    def detect_from_image(self, image: np.ndarray) -> dict:
        """
        Detect navigable path from camera frame using OpenCV.

        Uses color segmentation + edge detection to find crop rows
        and determine steering angle for the rover.

        Args:
            image: numpy array (H, W, C) in RGB

        Returns:
            {steering_angle, confidence, path_boundaries, center_offset}
        """
        if self.cv2 is None:
            return self._mock_path_detection()

        try:
            cv2 = self.cv2
            h, w = image.shape[:2]

            # Convert to HSV for color-based segmentation
            hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)

            # Green mask (crop rows)
            lower_green = np.array([25, 40, 40])
            upper_green = np.array([85, 255, 255])
            green_mask = cv2.inRange(hsv, lower_green, upper_green)

            # Brown/dirt mask (path between rows)
            lower_brown = np.array([8, 30, 50])
            upper_brown = np.array([25, 200, 200])
            brown_mask = cv2.inRange(hsv, lower_brown, upper_brown)

            # Focus on bottom half of image (closer to rover)
            roi_top = h // 2
            path_roi = brown_mask[roi_top:, :]
            green_roi = green_mask[roi_top:, :]

            # Find path center using moments
            moments = cv2.moments(path_roi)
            if moments['m00'] > 0:
                cx = int(moments['m10'] / moments['m00'])
                cy = int(moments['m01'] / moments['m00'])
            else:
                cx = w // 2
                cy = (h - roi_top) // 2

            # Calculate steering angle
            center_offset = (cx - w // 2) / (w // 2)  # -1 to 1
            steering_angle = center_offset * 45  # Max 45 degrees

            # Edge detection for path boundaries
            edges = cv2.Canny(path_roi, 50, 150)
            lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 50,
                                     minLineLength=50, maxLineGap=20)

            path_boundaries = []
            if lines is not None:
                for line in lines[:10]:  # Limit to 10 lines
                    x1, y1, x2, y2 = line[0]
                    path_boundaries.append({
                        'start': [int(x1), int(y1 + roi_top)],
                        'end': [int(x2), int(y2 + roi_top)],
                    })

            # Confidence based on path area ratio
            path_area = np.sum(path_roi > 0) / path_roi.size
            confidence = min(1.0, path_area * 3)  # Scale up

            return {
                'steering_angle': round(steering_angle, 2),
                'center_offset': round(center_offset, 4),
                'confidence': round(confidence, 4),
                'path_center': [cx, cy + roi_top],
                'path_boundaries': path_boundaries,
                'path_area_ratio': round(path_area, 4),
            }

        except Exception as e:
            logger.error(f"Path detection error: {e}")
            return self._mock_path_detection()

    def plan_path(self, waypoints: list, obstacles: list = None,
                  current_position: dict = None) -> dict:
        """
        Plan an optimal path through waypoints avoiding obstacles.
        Uses a simplified A*-inspired algorithm.

        Args:
            waypoints: List of {lat, lon} points to visit
            obstacles: List of {lat, lon, radius} obstacles to avoid
            current_position: {lat, lon} current rover position

        Returns:
            {path, total_distance, estimated_time, num_waypoints}
        """
        if not waypoints:
            return {
                'path': [],
                'total_distance': 0,
                'estimated_time': 0,
                'steering_angle': 0,
                'num_waypoints': 0,
            }

        obstacles = obstacles or []
        path = []
        total_distance = 0

        # Start from current position or first waypoint
        if current_position:
            current = current_position
        else:
            current = waypoints[0]

        path.append({
            'lat': current.get('lat', 0),
            'lon': current.get('lon', 0),
            'type': 'start',
        })

        for wp in waypoints:
            wp_lat = wp.get('lat', 0)
            wp_lon = wp.get('lon', 0)

            # Check for obstacles along the way
            needs_detour = False
            for obs in obstacles:
                obs_lat = obs.get('lat', 0)
                obs_lon = obs.get('lon', 0)
                obs_radius = obs.get('radius', 0.001)  # ~100m default

                # Simple distance check
                dist_to_obs = self._haversine(
                    current.get('lat', 0), current.get('lon', 0),
                    obs_lat, obs_lon
                )
                if dist_to_obs < obs_radius:
                    needs_detour = True
                    # Add detour waypoint (offset perpendicular to path)
                    detour_lat = obs_lat + obs_radius * 1.5
                    detour_lon = obs_lon + obs_radius * 1.5
                    path.append({
                        'lat': round(detour_lat, 6),
                        'lon': round(detour_lon, 6),
                        'type': 'detour',
                    })
                    total_distance += self._haversine(
                        current.get('lat', 0), current.get('lon', 0),
                        detour_lat, detour_lon
                    )
                    current = {'lat': detour_lat, 'lon': detour_lon}

            # Add waypoint
            seg_distance = self._haversine(
                current.get('lat', 0), current.get('lon', 0),
                wp_lat, wp_lon
            )
            total_distance += seg_distance

            path.append({
                'lat': wp_lat,
                'lon': wp_lon,
                'type': 'waypoint',
            })
            current = {'lat': wp_lat, 'lon': wp_lon}

        # Calculate steering to first waypoint
        if len(waypoints) > 0:
            first_wp = waypoints[0]
            bearing = self._bearing(
                path[0]['lat'], path[0]['lon'],
                first_wp.get('lat', 0), first_wp.get('lon', 0)
            )
            steering_angle = bearing
        else:
            steering_angle = 0

        # Estimated time at average speed of 1.2 m/s
        avg_speed = 1.2  # m/s
        estimated_time = total_distance / avg_speed if avg_speed > 0 else 0

        return {
            'path': path,
            'total_distance': round(total_distance, 2),
            'estimated_time': round(estimated_time, 1),
            'steering_angle': round(steering_angle, 2),
            'num_waypoints': len(waypoints),
        }

    @staticmethod
    def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate distance in meters between two GPS coordinates."""
        R = 6371000  # Earth radius in meters
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)

        a = (math.sin(dphi / 2) ** 2 +
             math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    @staticmethod
    def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate bearing angle between two GPS coordinates."""
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dlambda = math.radians(lon2 - lon1)

        y = math.sin(dlambda) * math.cos(phi2)
        x = (math.cos(phi1) * math.sin(phi2) -
             math.sin(phi1) * math.cos(phi2) * math.cos(dlambda))
        theta = math.atan2(y, x)
        return (math.degrees(theta) + 360) % 360

    def _mock_path_detection(self) -> dict:
        """Return mock path detection for development."""
        import random
        return {
            'steering_angle': round(random.uniform(-15, 15), 2),
            'center_offset': round(random.uniform(-0.3, 0.3), 4),
            'confidence': round(random.uniform(0.7, 0.95), 4),
            'path_center': [200, 300],
            'path_boundaries': [
                {'start': [100, 200], 'end': [120, 400]},
                {'start': [300, 200], 'end': [280, 400]},
            ],
            'path_area_ratio': round(random.uniform(0.15, 0.35), 4),
        }
