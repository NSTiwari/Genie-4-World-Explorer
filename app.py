"""World Explorer: a Flask front end for Google's Genie 4 world model.

Flow
----
1. The browser sends a text prompt and, optionally, a reference image (uploaded, or
   captured from a Google Maps Street View position) to POST /api/session.
2. Flask creates a live Genie 4 interaction and mints a short-lived auth token scoped
   to that one interaction. The Gemini API key never leaves the server.
3. The browser connects straight to Genie over WebRTC with that token. Video and
   audio arrive as real-time media tracks (late frames are dropped, not queued, so
   controls stay responsive), and key presses / text events go over the data channel.
4. The browser records the stream with MediaRecorder and uploads it when the session
   ends. Flask converts it to MP4 in ./recordings, like the recordings AI Studio keeps.
"""

import asyncio
import base64
import io
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory
from google import genai
from PIL import Image, ImageDraw, ImageFont, ImageOps

load_dotenv()

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
MAPS_API_KEY = os.environ.get("MAPS_API_KEY", "")
MODEL_ID = os.environ.get("GENIE_MODEL", "genie-4")
API_VERSION = "v1beta"
MAX_SESSION_SECONDS = int(os.environ.get("MAX_SESSION_SECONDS", "120"))  # Genie 4 hard cap is 120 s

WORLD_SIZE = (1280, 720)  # Genie 4 output is fixed 16:9, 1280x720
# Over WebRTC the world_setup event travels on an SCTP data channel (64 KB message
# limit). Base64 adds a third, so the docs advise keeping the seed JPEG under 48 KB.
REFERENCE_MAX_BYTES = 44 * 1024
BASE_DIR = Path(__file__).resolve().parent
RECORDINGS_DIR = BASE_DIR / "recordings"
CREDIT_NAME = os.environ.get("CREDIT_NAME", "Nitin Tiwari")
DEV_LOGO = BASE_DIR / "static" / "dev-logo.png"
GENIE_LOGO = BASE_DIR / "static" / "genie-logo.png"  # optional; a text badge is drawn if missing
FONTS_DIR = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
RECORDING_ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$")
SESSION_TTL_SECONDS = 60 * 60
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
STREETVIEW_URL = "https://maps.googleapis.com/maps/api/streetview"
STREETVIEW_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("world-explorer")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 400 * 1024 * 1024  # recordings can be ~100 MB

genai_client = (
    genai.Client(api_key=GEMINI_API_KEY, http_options={"api_version": API_VERSION})
    if GEMINI_API_KEY else None
)

# Sessions started from this server: id -> {prompt, reference (jpeg bytes), created}.
# Used to label recordings when the browser uploads them.
sessions: dict[str, dict] = {}
sessions_lock = threading.Lock()


# --------------------------------------------------------------------------- helpers

def load_image(raw: bytes) -> Image.Image:
    """Open any image, fix orientation, and center-crop it to 16:9 at 1280x720."""
    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img).convert("RGB")
    return ImageOps.fit(img, WORLD_SIZE, Image.Resampling.LANCZOS)


def encode_jpeg(img: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def to_world_jpeg(raw: bytes) -> bytes:
    return encode_jpeg(load_image(raw))


def to_seed_jpeg(raw: bytes) -> bytes:
    """16:9 JPEG small enough for the WebRTC data channel (< ~44 KB)."""
    img = load_image(raw)
    for size in (WORLD_SIZE, (1024, 576), (960, 540), (854, 480), (640, 360)):
        scaled = img if size == WORLD_SIZE else img.resize(size, Image.Resampling.LANCZOS)
        for quality in (85, 75, 65, 55, 45, 35):
            data = encode_jpeg(scaled, quality)
            if len(data) <= REFERENCE_MAX_BYTES:
                return data
    return data  # smallest attempt


def decode_data_url(data_url: str) -> bytes:
    """Accept either a data: URL or bare base64."""
    if data_url.startswith("data:") and "," in data_url:
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url)


def find_ffmpeg() -> str | None:
    try:
        import imageio_ffmpeg  # bundled binary, installed via requirements.txt

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return shutil.which("ffmpeg")


FFMPEG = find_ffmpeg()


def prune_sessions():
    cutoff = time.time() - SESSION_TTL_SECONDS
    with sessions_lock:
        for sid in [k for k, v in sessions.items() if v["created"] < cutoff]:
            sessions.pop(sid, None)


def cancel_interaction_later(interaction_id: str, delay: float = 3.0):
    """Cancel an interaction whose WebRTC handshake failed, in the background.

    After a gateway 502 the interaction can stay half-attached and would otherwise
    hold one of the project's concurrent-session slots. It can still be reached over
    the WebSocket transport, so connect that way and cancel it.
    """
    async def run():
        await asyncio.sleep(delay)
        client = genai.Client(api_key=GEMINI_API_KEY, http_options={"api_version": API_VERSION})
        for attempt in range(3):
            try:
                async with client.aio.interactions.connect(
                    interaction_id, api_version=API_VERSION, timeout=15
                ) as live:
                    await live.cancel()
                log.info("Cancelled abandoned interaction %s", interaction_id)
                return
            except Exception as exc:  # noqa: BLE001
                log.info("Cleanup of %s, attempt %d: %s", interaction_id, attempt + 1, exc)
                await asyncio.sleep(5)

    with sessions_lock:
        sessions.pop(interaction_id, None)
    threading.Thread(target=lambda: asyncio.run(run()), daemon=True).start()


def _font(names: list[str], size: int):
    for name in names:
        try:
            return ImageFont.truetype(str(FONTS_DIR / name), size)
        except OSError:
            continue
    return ImageFont.load_default(size)


# Video overlay style (font files are looked up in the Windows Fonts folder).
OVERLAY_FONT = ["bahnschrift.ttf", "segoeui.ttf", "arial.ttf"]
OVERLAY_TEXT_SIZE = 18
OVERLAY_PILL_ALPHA = 150  # 0 = invisible, 255 = solid


def build_overlay(path: Path, font_files=None, size: int = OVERLAY_TEXT_SIZE,
                  pill_alpha: int = OVERLAY_PILL_ALPHA):
    """Transparent 1280x720 PNG burned into every recording.

    Top centre: the same "Made with 🧡 by <logo> <name>" credit as the page.
    Bottom right: the Genie 4 badge (static/genie-logo.png if present, else text).
    """
    W, H = WORLD_SIZE
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    font_files = font_files or OVERLAY_FONT
    text_font = _font(font_files, size)
    emoji_font = _font(["seguiemj.ttf"], size)
    logo = None
    if DEV_LOGO.exists():
        logo = Image.open(DEV_LOGO).convert("RGBA")
        logo = logo.resize((round(logo.width * size / logo.height), size), Image.Resampling.LANCZOS)

    gap = max(6, size // 2)
    pieces = [("text", "Made with"), ("emoji", "🧡"), ("text", "by")]
    if logo:
        pieces.append(("logo", None))
    pieces.append(("text", CREDIT_NAME))

    def width(kind, value):
        if kind == "logo":
            return logo.width
        font = emoji_font if kind == "emoji" else text_font
        return round(draw.textlength(value, font=font, embedded_color=kind == "emoji"))

    content_w = sum(width(k, v) for k, v in pieces) + gap * (len(pieces) - 1)
    pad_x, pad_y, top = round(size * 0.9), round(size * 0.4), 16
    pill_h = size + pad_y * 2 + 4
    left = (W - content_w) // 2
    draw.rounded_rectangle(
        (left - pad_x, top, left + content_w + pad_x, top + pill_h),
        radius=pill_h // 2, fill=(255, 255, 255, pill_alpha),
    )
    x, mid = left, top + pill_h // 2
    for kind, value in pieces:
        if kind == "logo":
            img.alpha_composite(logo, (x, mid - logo.height // 2))
        elif kind == "emoji":
            draw.text((x, mid), value, font=emoji_font, embedded_color=True, anchor="lm")
        else:
            draw.text((x, mid), value, font=text_font, fill=(31, 31, 31, 255), anchor="lm")
        x += width(kind, value) + gap

    margin = 16
    if GENIE_LOGO.exists():
        badge = Image.open(GENIE_LOGO).convert("RGBA")
        bh = round(size * 2)
        badge = badge.resize((round(badge.width * bh / badge.height), bh), Image.Resampling.LANCZOS)
        img.alpha_composite(badge, (W - badge.width - margin, H - badge.height - margin))
    else:
        label, font = "Genie 4", _font(font_files, size)
        tw = round(draw.textlength(label, font=font))
        bw, bh = tw + size * 2, pill_h
        x0, y0 = W - bw - margin, H - bh - margin
        draw.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=bh // 2, fill=(0, 0, 0, pill_alpha - 30))
        draw.text((x0 + bw // 2, y0 + bh // 2), label, font=font, fill=(255, 255, 255, 255), anchor="mm")

    img.save(path)


def recording_view(meta: dict) -> dict:
    rid = meta["id"]
    view = dict(meta, url=f"/recordings/{rid}.mp4")
    if meta.get("has_reference"):
        view["reference_url"] = f"/recordings/{rid}.ref.jpg"
    return view


# --------------------------------------------------------------------------- pages

@app.route("/")
def index():
    return render_template(
        "index.html",
        maps_api_key=MAPS_API_KEY,
        max_seconds=MAX_SESSION_SECONDS,
        recording_enabled=bool(FFMPEG),
        credit_name=CREDIT_NAME,
    )


# --------------------------------------------------------------------------- Street View

@app.post("/api/streetview")
def streetview():
    """Capture the current Street View POV as a 16:9 reference image."""
    if not MAPS_API_KEY:
        return jsonify(error="Google Maps is not available right now."), 500

    data = request.get_json(silent=True) or {}
    try:
        lat = float(data["lat"])
        lng = float(data["lng"])
        heading = float(data.get("heading", 0))
        pitch = max(-90.0, min(90.0, float(data.get("pitch", 0))))
        fov = max(10.0, min(120.0, float(data.get("fov", 90))))
    except (KeyError, TypeError, ValueError):
        return jsonify(error="lat and lng are required numbers."), 400

    location = f"{lat},{lng}"
    # A key restricted to "Websites" checks the Referer header, which server-side
    # requests don't send by default; send this app's own origin.
    headers = {"Referer": request.host_url}
    try:
        meta = requests.get(
            STREETVIEW_META_URL,
            params={"location": location, "radius": 50, "key": MAPS_API_KEY},
            headers=headers, timeout=15,
        ).json()
        if meta.get("status") != "OK":
            return jsonify(error=f"No Street View imagery here ({meta.get('status')})."), 404

        # The Static API caps at 640 px per side; 640x360 keeps the 16:9 aspect.
        resp = requests.get(
            STREETVIEW_URL,
            params={
                "size": "640x360", "location": location, "heading": heading,
                "pitch": pitch, "fov": fov, "radius": 50, "source": "outdoor",
                "return_error_code": "true", "key": MAPS_API_KEY,
            },
            headers=headers, timeout=20,
        )
        resp.raise_for_status()
        jpeg = to_world_jpeg(resp.content)
    except requests.RequestException as exc:
        log.warning("Street View fetch failed: %s", exc)
        return jsonify(error="Could not fetch Street View image."), 502
    except Exception as exc:  # noqa: BLE001 - bad image bytes
        log.warning("Street View decode failed: %s", exc)
        return jsonify(error="Street View returned an unreadable image."), 502

    return jsonify(
        image="data:image/jpeg;base64," + base64.b64encode(jpeg).decode(),
        date=meta.get("date"),
        copyright=meta.get("copyright"),
    )


# --------------------------------------------------------------------------- live session

@app.post("/api/session")
def create_session():
    """Create a Genie interaction and hand the browser a token scoped to it."""
    if not genai_client:
        log.error("GEMINI_API_KEY is not set; rejecting session.")
        return jsonify(error="The server is not configured for generation."), 500

    data = request.get_json(silent=True) or {}
    prompt = str(data.get("prompt", "")).strip()[:2000]
    if not prompt:
        return jsonify(error="Please enter a world prompt."), 400

    seed = None
    if data.get("image"):
        try:
            seed = to_seed_jpeg(decode_data_url(data["image"]))
        except Exception:  # noqa: BLE001
            return jsonify(error="Could not read the reference image."), 400

    try:
        interaction = genai_client.interactions.create(model=MODEL_ID, api_version=API_VERSION)
        token = genai_client.interactions.auth_tokens.create(
            interaction_id=interaction.id, api_version=API_VERSION
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Could not create interaction")
        message = getattr(exc, "message", None) or str(exc)
        return jsonify(error=f"Could not start a session: {message}"), 502

    world_setup = {"event_type": "world_setup", "world_prompt": {"text": prompt}}
    if seed:
        world_setup["reference_image"] = {
            "mime_type": "image/jpeg",
            "data": base64.b64encode(seed).decode(),
        }

    prune_sessions()
    with sessions_lock:
        sessions[interaction.id] = {"prompt": prompt, "reference": seed, "created": time.time()}
    log.info("Interaction %s created (reference image: %s)",
             interaction.id, f"{len(seed) // 1024} KB" if seed else "none")

    return jsonify(
        interaction_id=interaction.id,
        auth_token=token.auth_token,
        api_version=API_VERSION,
        world_setup=world_setup,
        max_seconds=MAX_SESSION_SECONDS,
    )


@app.post("/genai/<api_version>/interactions/<path:target>")
def webrtc_signaling(api_version, target):
    """Relay the WebRTC SDP offer/answer exchange to the Gemini API.

    The browser SDK is pointed at this server (baseUrl=/genai/) so the one-off
    signaling POST goes server-to-server. Media still flows directly between the
    browser and Genie over WebRTC. Relaying avoids browser CORS failures (Google's
    error responses carry no CORS headers, so the browser hides the real error)
    and lets us log and report what went wrong.

    No retry here: Google's gateway sometimes returns 502 even though the backend
    has already attached a client, after which the same interaction rejects every
    new offer ("Another client is already connected"). The browser recovers by
    starting a fresh interaction instead.
    """
    if api_version != API_VERSION or not target.endswith(":webrtc"):
        abort(404)
    interaction_id = target[: -len(":webrtc")]
    with sessions_lock:
        if interaction_id not in sessions:
            abort(404)

    url = f"{GEMINI_BASE_URL}/{API_VERSION}/interactions/{interaction_id}:webrtc"
    token = request.headers.get("x-goog-api-key", "") or GEMINI_API_KEY
    started = time.monotonic()
    try:
        resp = requests.post(
            url, data=request.get_data(), timeout=60,
            headers={"content-type": "application/json", "x-goog-api-key": token},
        )
    except requests.RequestException as exc:
        log.warning("Signaling for %s failed: %s", interaction_id, exc)
        cancel_interaction_later(interaction_id)
        return jsonify(error={"message": f"Could not reach Genie ({exc.__class__.__name__})."}), 502

    elapsed = time.monotonic() - started
    if resp.status_code == 200:
        log.info("WebRTC signaling OK for %s (%.1f s)", interaction_id, elapsed)
        return Response(resp.content, status=200,
                        content_type=resp.headers.get("content-type", "application/json"))

    log.warning("Signaling for %s -> HTTP %s after %.1f s: %s",
                interaction_id, resp.status_code, elapsed, " ".join(resp.text[:200].split()))
    cancel_interaction_later(interaction_id)
    try:
        message = resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        message = f"Genie's server returned an error (HTTP {resp.status_code})."  # e.g. an HTML 502 page
    return jsonify(error={"message": message}), resp.status_code


# --------------------------------------------------------------------------- recordings

@app.get("/api/recordings")
def list_recordings():
    items = []
    if RECORDINGS_DIR.exists():
        for meta_file in RECORDINGS_DIR.glob("*.json"):
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if (RECORDINGS_DIR / f"{meta.get('id')}.mp4").exists():
                items.append(recording_view(meta))
    items.sort(key=lambda m: m.get("created", 0), reverse=True)
    return jsonify(items)


@app.post("/api/recordings")
def upload_recording():
    """Receive the browser's MediaRecorder capture and store it as MP4."""
    if not FFMPEG:
        return jsonify(error="Recording is not available on this server."), 503
    upload = request.files.get("video")
    if not upload:
        return jsonify(error="No video uploaded."), 400

    session_id = request.form.get("session_id", "")
    with sessions_lock:
        session = sessions.pop(session_id, None)
    if session is None:
        return jsonify(error="Unknown or expired session."), 404

    try:
        duration = max(0.0, min(float(request.form.get("duration", 0)), 600.0))
    except ValueError:
        duration = 0.0

    RECORDINGS_DIR.mkdir(exist_ok=True)
    rid = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    out = RECORDINGS_DIR / f"{rid}.mp4"
    is_mp4 = "mp4" in (upload.mimetype or "")

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / ("in.mp4" if is_mp4 else "in.webm")
        upload.save(src)
        overlay = Path(tmp) / "overlay.png"
        build_overlay(overlay)
        # Re-encode to H.264/AAC at a constant 24 fps (MediaRecorder output has
        # variable timing and, for WebM, no duration) and burn in the credit and
        # Genie 4 badge.
        video_filter = (
            f"[0:v]scale={WORLD_SIZE[0]}:{WORLD_SIZE[1]}:force_original_aspect_ratio=decrease,"
            f"pad={WORLD_SIZE[0]}:{WORLD_SIZE[1]}:(ow-iw)/2:(oh-ih)/2,fps=24[base];"
            "[base][1:v]overlay=0:0,format=yuv420p[v]"
        )
        cmd = [FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-i", str(overlay),
               "-filter_complex", video_filter, "-map", "[v]", "-map", "0:a?",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(out)]
        try:
            subprocess.run(cmd, check=True, timeout=900, capture_output=True)
        except (subprocess.SubprocessError, OSError) as exc:
            stderr = getattr(exc, "stderr", b"") or b""
            log.error("Recording %s failed to encode: %s %s", rid, exc, stderr[-500:])
            out.unlink(missing_ok=True)
            return jsonify(error="Could not save the recording."), 500

    if session.get("reference"):
        (RECORDINGS_DIR / f"{rid}.ref.jpg").write_bytes(session["reference"])
    meta = {
        "id": rid,
        "prompt": session["prompt"],
        "created": session["created"],
        "duration": round(duration, 1),
        "has_reference": bool(session.get("reference")),
    }
    (RECORDINGS_DIR / f"{rid}.json").write_text(json.dumps(meta), encoding="utf-8")
    log.info("Saved recording %s (%.1f s, %.1f MB)", rid, duration, out.stat().st_size / 1e6)
    return jsonify(recording_view(meta))


@app.get("/recordings/<path:name>")
def recording_file(name):
    if not re.fullmatch(r"[0-9a-f-]+(\.mp4|\.ref\.jpg)", name):
        abort(404)
    return send_from_directory(RECORDINGS_DIR, name, conditional=True,
                               as_attachment=request.args.get("download") == "1")


@app.delete("/api/recordings/<rid>")
def delete_recording(rid):
    if not RECORDING_ID_RE.fullmatch(rid):
        abort(404)
    for suffix in (".mp4", ".json", ".ref.jpg"):
        path = RECORDINGS_DIR / f"{rid}{suffix}"
        for attempt in range(10):  # Windows keeps files locked while a reader has them open
            try:
                path.unlink(missing_ok=True)
                break
            except PermissionError:
                if attempt == 9:
                    return jsonify(error="The recording is in use. Close it and try again."), 409
                time.sleep(0.2)
    return jsonify(ok=True)


if __name__ == "__main__":
    if not GEMINI_API_KEY:
        log.warning("GEMINI_API_KEY is not set; generation will fail.")
    if not MAPS_API_KEY:
        log.warning("MAPS_API_KEY is not set; the Google Maps picker will be disabled.")
    if not FFMPEG:
        log.warning("ffmpeg not found; sessions will not be saved (pip install imageio-ffmpeg).")
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False, threaded=True)
