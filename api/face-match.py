"""
Vercel Python Function: /api/face-match

Face matching using face_recognition (dlib ResNet model).
Replaces InsightFace/onnxruntime which exceeded Vercel's 500 MB Lambda limit.

POST body:
  {
    "photo_base64": "<base64-encoded event photo>",
    "athletes": [
      { "name": "Athlete Name", "headshot_base64": "<base64>" | null }
    ]
  }

Response:
  { "matches": [{ "name": "...", "face_confidence": 0.82, "position_x": 0.34 }] }

Confidence scale:
  distance 0.0  → confidence 1.00  (identical)
  distance 0.40 → confidence 0.95  (strong match)
  distance 0.55 → confidence 0.50  (at threshold)
  distance 0.70 → confidence 0.09  (poor match)

  Set the app's confidence threshold to ~0.40–0.50 for best results.
"""

from http.server import BaseHTTPRequestHandler
import json
import base64
import hashlib
import math
import io

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# Headshot encoding cache — persists across warm invocations
# ---------------------------------------------------------------------------
_encoding_cache: dict[str, np.ndarray | None] = {}
_MAX_CACHE = 500


def _b64_to_rgb_array(b64: str) -> np.ndarray | None:
    """Decode a base64 JPEG/PNG string to an RGB numpy array."""
    try:
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.array(img)
    except Exception:
        return None


def _largest_face_encoding(img_array: np.ndarray) -> np.ndarray | None:
    """
    Detect faces in img_array and return the encoding of the largest face.
    Returns None if no face is detected.
    """
    import face_recognition

    locations = face_recognition.face_locations(img_array, model="hog")
    if not locations:
        return None

    # Pick the largest face by bounding-box area
    def area(loc):
        top, right, bottom, left = loc
        return (bottom - top) * (right - left)

    best_loc = max(locations, key=area)
    encodings = face_recognition.face_encodings(img_array, [best_loc])
    return encodings[0] if encodings else None


def _cached_headshot_encoding(b64: str) -> np.ndarray | None:
    """Return (cached) face encoding for a headshot."""
    key = hashlib.md5(b64[:512].encode()).hexdigest()
    if key in _encoding_cache:
        return _encoding_cache[key]

    img = _b64_to_rgb_array(b64)
    enc = _largest_face_encoding(img) if img is not None else None

    if len(_encoding_cache) >= _MAX_CACHE:
        _encoding_cache.clear()
    _encoding_cache[key] = enc
    return enc


def _distance_to_confidence(distance: float) -> float:
    """
    Map dlib face distance → 0-1 confidence via sigmoid.
    dlib threshold is 0.6; we centre the sigmoid at 0.55 for a little extra headroom.
    """
    return round(1.0 / (1.0 + math.exp(10.0 * (distance - 0.55))), 3)


def _process(body: dict) -> dict:
    import face_recognition

    photo_b64: str = body.get("photo_base64", "")
    athletes: list[dict] = body.get("athletes", [])

    if not photo_b64 or not athletes:
        return {"matches": []}

    # --- 1. Decode event photo ---
    photo_array = _b64_to_rgb_array(photo_b64)
    if photo_array is None:
        return {"matches": []}

    # --- 2. Detect faces in event photo ---
    face_locations = face_recognition.face_locations(photo_array, model="hog")
    if not face_locations:
        return {"matches": []}

    event_encodings = face_recognition.face_encodings(photo_array, face_locations)
    photo_width = photo_array.shape[1]

    # --- 3. Get headshot encodings (cached) ---
    hs_encodings: list[np.ndarray | None] = [
        _cached_headshot_encoding(a.get("headshot_base64") or "")
        if a.get("headshot_base64")
        else None
        for a in athletes
    ]

    valid_idxs = [i for i, e in enumerate(hs_encodings) if e is not None]
    if not valid_idxs:
        return {"matches": []}

    known_encodings = [hs_encodings[i] for i in valid_idxs]

    # --- 4. Match each event face to the closest headshot ---
    best_per_athlete: dict[str, dict] = {}

    for event_enc, (top, right, bottom, left) in zip(event_encodings, face_locations):
        cx = (left + right) / 2.0
        position_x = float(np.clip(cx / photo_width, 0.0, 1.0))

        distances = face_recognition.face_distance(known_encodings, event_enc)
        best_local = int(np.argmin(distances))
        best_dist = float(distances[best_local])

        name = athletes[valid_idxs[best_local]]["name"]
        confidence = _distance_to_confidence(best_dist)

        if name not in best_per_athlete or confidence > best_per_athlete[name]["face_confidence"]:
            best_per_athlete[name] = {
                "name": name,
                "face_confidence": confidence,
                "position_x": round(position_x, 3),
            }

    return {"matches": list(best_per_athlete.values())}


# ---------------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------------

class handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            result = _process(json.loads(raw))
            payload = json.dumps(result).encode()
            self.send_response(200)
        except Exception as exc:
            payload = json.dumps({"error": str(exc), "matches": []}).encode()
            self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass
