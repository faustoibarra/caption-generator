"""
Vercel Python Function: /api/face-match

Performs face matching using InsightFace (ArcFace, buffalo_s model).

POST body:
  {
    "photo_base64": "<base64-encoded event photo>",
    "athletes": [
      { "name": "Athlete Name", "headshot_base64": "<base64>" | null }
    ]
  }

Response:
  {
    "matches": [
      { "name": "Athlete Name", "face_confidence": 0.87, "position_x": 0.34 }
    ]
  }

Cold start: first invocation downloads InsightFace buffalo_s model (~67 MB) to /tmp.
Subsequent warm invocations reuse the cached model and headshot embeddings.
"""

from http.server import BaseHTTPRequestHandler
import json
import base64
import hashlib
import math
import os
import sys

import numpy as np

# ---------------------------------------------------------------------------
# Module-level caches — persist across warm invocations in the same instance
# ---------------------------------------------------------------------------
_face_app = None
_headshot_cache: dict[str, np.ndarray | None] = {}   # md5(b64_prefix) → embedding
_MAX_CACHE = 500                                       # entries before we flush


def _get_face_app():
    """Load (and cache) the InsightFace FaceAnalysis app."""
    global _face_app
    if _face_app is not None:
        return _face_app

    from insightface.app import FaceAnalysis

    model_root = "/tmp/insightface"
    os.makedirs(model_root, exist_ok=True)

    app = FaceAnalysis(
        name="buffalo_s",
        root=model_root,
        providers=["CPUExecutionProvider"],
        allowed_modules=["detection", "recognition"],
    )
    # det_size=(640,640) recommended input resolution; det_thresh=0.3 catches
    # partially-visible and angled faces common in sports action shots (default is 0.5)
    app.prepare(ctx_id=-1, det_size=(640, 640), det_thresh=0.3)
    _face_app = app
    return _face_app


def _decode_img(b64: str):
    """Decode base64 → OpenCV BGR image array, or None on failure."""
    import cv2
    try:
        raw = base64.b64decode(b64)
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception:
        return None


def _get_largest_face_embedding(app, img) -> np.ndarray | None:
    """Detect faces in img and return the embedding of the largest face, or None."""
    try:
        faces = app.get(img)
    except Exception:
        return None
    if not faces:
        return None
    # Pick the face with the largest bounding-box area (most prominent in the frame)
    largest = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return largest.embedding


def _headshot_embedding(app, b64: str) -> np.ndarray | None:
    """Return the face embedding for a headshot, with caching."""
    global _headshot_cache

    # Cache key: md5 of the first 512 chars of the b64 string (fast, collision-resistant enough)
    key = hashlib.md5(b64[:512].encode()).hexdigest()
    if key in _headshot_cache:
        return _headshot_cache[key]

    img = _decode_img(b64)
    emb = _get_largest_face_embedding(app, img) if img is not None else None

    if len(_headshot_cache) >= _MAX_CACHE:
        _headshot_cache.clear()
    _headshot_cache[key] = emb
    return emb


def _sim_to_confidence(cosine_sim: float) -> float:
    """
    Map ArcFace cosine similarity → 0-1 confidence score.

    Sigmoid centred at the buffalo_s verification threshold (~0.28):
      sim 0.28  → 0.50
      sim 0.40  → 0.80
      sim 0.50  → 0.93
      sim 0.60  → 0.98

    Users should lower the confidence threshold in the UI to ~0.40-0.50
    when using this face model (vs ~0.80 for Claude Vision).
    """
    return round(1.0 / (1.0 + math.exp(-12.0 * (cosine_sim - 0.28))), 3)


def _process(body: dict) -> dict:
    """Core matching logic."""
    app = _get_face_app()

    photo_b64: str = body.get("photo_base64", "")
    athletes: list[dict] = body.get("athletes", [])

    if not photo_b64 or not athletes:
        return {"matches": []}

    # --- 1. Detect faces in the event photo ---
    photo_img = _decode_img(photo_b64)
    if photo_img is None:
        return {"matches": []}

    import cv2  # already imported transitively via insightface
    try:
        event_faces = app.get(photo_img)
    except Exception:
        return {"matches": []}

    if not event_faces:
        return {"matches": []}

    photo_w = photo_img.shape[1]

    # --- 2. Compute headshot embeddings (cached) ---
    hs_embeddings: list[np.ndarray | None] = []
    for ath in athletes:
        b64 = ath.get("headshot_base64") or ""
        emb = _headshot_embedding(app, b64) if b64 else None
        hs_embeddings.append(emb)

    # Pre-stack non-None embeddings for fast batch cosine similarity
    valid_idxs = [i for i, e in enumerate(hs_embeddings) if e is not None]
    if not valid_idxs:
        return {"matches": []}

    # Stack into (N_athletes, 512) matrix; ArcFace embeddings are L2-normalised
    emb_matrix = np.stack([hs_embeddings[i] for i in valid_idxs])  # (N, 512)

    # --- 3. Match each detected face to the best headshot ---
    best_per_athlete: dict[str, dict] = {}  # athlete_name → best match so far

    for face in event_faces:
        ev_emb = face.embedding  # (512,)
        bbox = face.bbox          # [x1, y1, x2, y2]
        cx = (bbox[0] + bbox[2]) / 2.0
        position_x = float(np.clip(cx / photo_w, 0.0, 1.0))

        # Cosine similarities (ArcFace embeddings are unit-norm, so dot product = cosine sim)
        sims = emb_matrix @ ev_emb  # (N,) — dot products
        best_local = int(np.argmax(sims))
        best_sim = float(sims[best_local])

        athlete_idx = valid_idxs[best_local]
        name = athletes[athlete_idx]["name"]
        confidence = _sim_to_confidence(best_sim)

        # Keep the highest-confidence match per athlete (multiple event faces may match same athlete)
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
            body = json.loads(raw)
            result = _process(body)
            payload = json.dumps(result).encode()
            self.send_response(200)
        except Exception as exc:
            payload = json.dumps({"error": str(exc), "matches": []}).encode()
            self.send_response(500)

        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # silence access logs
        pass
