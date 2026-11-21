/* World Explorer – browser side.
 * - Collects a prompt + optional reference image (upload or Google Street View capture).
 * - Asks Flask for a live session (interaction id + short-lived auth token), then
 *   connects straight to Genie over WebRTC: video/audio arrive as real-time media
 *   tracks, key presses and text events go over the "events" data channel.
 * - Records the stream with MediaRecorder and uploads it to Flask when it ends.
 */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG || { maxSeconds: 120, recording: false, mapsKey: "", sdkUrl: "" };

  const KEY_MAP = {
    KeyW: "key_w", KeyA: "key_a", KeyS: "key_s", KeyD: "key_d",
    ArrowUp: "arrow_up", ArrowDown: "arrow_down", ArrowLeft: "arrow_left", ArrowRight: "arrow_right",
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    prompt: $("prompt"), examples: $("examples"),
    fileInput: $("file-input"), dropzone: $("dropzone"),
    ref: $("ref"), refImg: $("ref-img"), refCaption: $("ref-caption"), refClear: $("ref-clear"),
    start: $("start-btn"), end: $("end-btn"), mute: $("mute-btn"), snap: $("snap-btn"), fs: $("fs-btn"),
    stage: $("stage"), video: $("screen"), overlay: $("overlay"), overlayText: $("overlay-text"),
    spinner: $("spinner"), status: $("status-pill"), timer: $("timer"), recPill: $("rec-pill"),
    eventForm: $("event-form"), eventInput: $("event-input"), eventBtn: $("event-btn"),
  };

  const state = {
    session: null,          // the active Session object, if any
    live: false,            // frames are flowing and input is accepted
    hasFrame: false,
    refImage: null,         // data URL
    autoPrompt: null,       // last prompt we filled in automatically
    held: new Set(),
    muted: false,
    timerId: null, deadline: 0,
  };

  let sdkPromise = null;
  const loadSdk = () => (sdkPromise ||= import(CFG.sdkUrl));

  /* ------------------------------------------------------------------ UI helpers */

  function setOverlay(text, { spinner = false, error = false, hide = false } = {}) {
    el.overlay.classList.toggle("gone", hide);
    el.overlay.classList.toggle("error", error);
    el.spinner.classList.toggle("hidden", !spinner);
    el.overlayText.textContent = text;
  }

  function setStatus(text, cls = "") {
    el.status.textContent = text;
    el.status.className = "pill " + cls;
  }

  function setRunning(running) {
    el.start.disabled = running;
    el.end.disabled = !running;
    el.prompt.disabled = running;
  }

  function setLive(live) {
    state.live = live;
    el.eventInput.disabled = !live;
    el.eventBtn.disabled = !live;
    el.snap.disabled = !live && !state.hasFrame;
    el.stage.classList.toggle("live", live);
    if (!live) releaseAllKeys();
  }

  function setReference(dataUrl, caption) {
    state.refImage = dataUrl;
    if (dataUrl) {
      el.refImg.src = dataUrl;
      el.refCaption.textContent = caption || "";
      el.ref.classList.remove("hidden");
    } else {
      el.refImg.removeAttribute("src");
      el.ref.classList.add("hidden");
    }
  }

  /* ------------------------------------------------------------------ prompt + upload */

  el.examples.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) { el.prompt.value = chip.textContent.trim(); state.autoPrompt = null; }
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", String(on));
        $("tab-" + t.dataset.tab).classList.toggle("hidden", !on);
      });
      if (tab.dataset.tab === "maps" && window.__mapsPicker) window.__mapsPicker.refresh();
    });
  });

  // Deep link: /#maps opens the Google Maps tab.
  if (location.hash === "#maps") {
    const mapsTab = document.querySelector('.tab[data-tab="maps"]');
    if (mapsTab) mapsTab.click();
  }

  function readFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setReference(reader.result, file.name);
    reader.readAsDataURL(file);
  }

  el.fileInput.addEventListener("change", () => readFile(el.fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("drag"); }));
  el.dropzone.addEventListener("drop", (e) => readFile(e.dataTransfer.files[0]));
  el.refClear.addEventListener("click", () => { setReference(null); el.fileInput.value = ""; });

  /* ------------------------------------------------------------------ timer */

  function startTimer(onExpire) {
    stopTimer();
    state.deadline = performance.now() + CFG.maxSeconds * 1000;
    const tick = () => {
      const left = Math.max(0, Math.round((state.deadline - performance.now()) / 1000));
      el.timer.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
      el.timer.classList.toggle("low", left <= 15);
      if (left === 0) { stopTimer(); onExpire && onExpire(); }
    };
    tick();
    state.timerId = setInterval(tick, 250);
  }
  function stopTimer() { clearInterval(state.timerId); state.timerId = null; }

  /* ------------------------------------------------------------------ recorder */

  function pickRecorderType() {
    const types = [
      "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  }

  class Recorder {
    constructor(stream) {
      this.chunks = [];
      this.startedAt = performance.now();
      const mimeType = pickRecorderType();
      this.rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 160_000 });
      this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.rec.start(1000);
    }
    stop() {
      return new Promise((resolve) => {
        const duration = (performance.now() - this.startedAt) / 1000;
        const done = () => resolve({ blob: new Blob(this.chunks, { type: this.rec.mimeType || "video/webm" }), duration });
        if (this.rec.state === "inactive") return done();
        this.rec.onstop = done;
        try { this.rec.stop(); } catch (_) { done(); }
      });
    }
  }

  /* ------------------------------------------------------------------ live session */

  class Session {
    constructor(info) {
      this.info = info;               // {interaction_id, auth_token, api_version, world_setup}
      this.conn = null;
      this.transport = null;
      this.recorder = null;
      this.finished = false;
      this.failed = false;
    }

    async connect() {
      const { GoogleGenAI, InteractionWebRTCTransport } = await loadSdk();
      // baseUrl points the SDK's WebRTC signaling request at our Flask relay
      // (/genai/...); the media itself still flows directly to Genie.
      const ai = new GoogleGenAI({
        apiKey: this.info.auth_token,
        httpOptions: { apiVersion: this.info.api_version, baseUrl: `${location.origin}/genai/` },
      });
      this.transport = new InteractionWebRTCTransport({ videoElement: el.video });
      this.conn = await ai.interactions.connect(this.info.interaction_id, {
        transport: this.transport,
        api_version: this.info.api_version,
      });
      await this.conn.send(this.info.world_setup);
      this.listen();
    }

    async listen() {
      try {
        for await (const ev of this.conn.receive()) {
          const type = ev && ev.event_type;
          if (type === "error") {
            const msg = (ev.error && (ev.error.message || ev.error.code)) || "Unknown error";
            this.fail(`Generation error: ${msg}`);
            break;
          }
          if (type === "reconnection_required") {
            this.fail("The session was interrupted. Please start again.");
            break;
          }
          if (type === "interaction.completed" || type === "interaction.canceled" || type === "interaction.cancelled") break;
        }
      } catch (err) {
        if (!this.finished) this.fail(`Connection lost: ${err && err.message ? err.message : err}`);
      }
      this.finish();
    }

    send(event) {
      if (!this.conn || this.finished) return;
      try {
        const p = this.conn.send(event);
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* channel closing */ }
    }

    onFirstFrame() {
      if (this.finished || state.live) return;
      state.hasFrame = true;
      setOverlay("", { hide: true });
      setStatus("Live", "live");
      setLive(true);
      startTimer(() => this.end());
      el.stage.focus();
      const stream = el.video.srcObject || this.transport.remoteMediaStream;
      if (CFG.recording && stream && window.MediaRecorder) {
        try {
          this.recorder = new Recorder(stream);
          el.recPill.classList.remove("hidden");
        } catch (err) {
          console.warn("Recording unavailable:", err);
        }
      }
    }

    // Ask Genie to finish (this stops generation and billing). If it hasn't
    // confirmed within 2 s, cancel outright.
    async end() {
      if (!this.conn || this.finished) return;
      setStatus("Ending…");
      setLive(false);
      stopTimer();
      el.end.disabled = true;
      try { await this.conn.complete(); } catch (_) { /* ignore */ }
      setTimeout(() => {
        if (!this.finished) this.conn.cancel().catch(() => {}).finally(() => this.finish());
      }, 2000);
    }

    fail(message) {
      this.failed = true;
      this.errorMessage = message;
    }

    // Drop a session that never got going (failed handshake) without touching the UI.
    discard() {
      this.finished = true;
      try { if (this.conn) this.conn.cancel().catch(() => {}); } catch (_) { /* ignore */ }
      if (state.session === this) state.session = null;
    }

    async finish() {
      if (this.finished) return;
      this.finished = true;
      setLive(false);
      setRunning(false);
      stopTimer();
      el.recPill.classList.add("hidden");
      if (this.failed) {
        setStatus("Error");
        setOverlay(this.errorMessage, { error: true });
        el.overlay.classList.toggle("dim", state.hasFrame);
      } else {
        setStatus("Ended");
        setOverlay("Session ended. Tweak the prompt and generate again.");
        if (state.hasFrame) el.overlay.classList.add("gone");
      }
      el.snap.disabled = !state.hasFrame;
      if (state.session === this) state.session = null;

      if (this.recorder) {
        const { blob, duration } = await this.recorder.stop();
        this.recorder = null;
        if (blob.size > 0) uploadRecording(this.info.interaction_id, blob, duration);
      }
    }
  }

  async function startSession() {
    const prompt = el.prompt.value.trim();
    if (!prompt) { el.prompt.focus(); setOverlay("Please enter a world prompt first.", { error: true }); return; }

    state.hasFrame = false;
    el.video.muted = state.muted;
    setRunning(true);
    setLive(false);
    setStatus("Connecting…");
    el.overlay.classList.remove("dim");
    el.timer.textContent = "--:--";
    setOverlay("Connecting…", { spinner: true });

    // Genie's WebRTC handshake sometimes fails on Google's side (HTTP 502), and the
    // interaction can't be reused afterwards. So on a handshake failure, start over
    // with a brand-new interaction, up to MAX_ATTEMPTS times.
    const MAX_ATTEMPTS = 4;
    const isHandshakeFailure = (msg) =>
      /signaling|HTTP status (5\d\d|429)|Another client is already connected|Could not reach Genie/i.test(msg);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let session = null;
      try {
        const [res] = await Promise.all([
          fetch("/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, image: state.refImage || null }),
          }),
          loadSdk(),
        ]);
        const info = await res.json();
        if (!res.ok) throw new Error(info.error || "Could not start a session.");

        session = new Session(info);
        state.session = session;
        setStatus("Building your world…");
        setOverlay(
          attempt === 1
            ? "Building your world… This usually takes 5 to 10 seconds."
            : `Genie didn't answer, trying again (${attempt} of ${MAX_ATTEMPTS})…`,
          { spinner: true },
        );
        await session.connect();
        return; // connected; the Session takes it from here
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn(`Connect attempt ${attempt} failed:`, msg);
        if (session) session.discard();
        if (session && isHandshakeFailure(msg) && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        setRunning(false);
        setStatus("Error");
        setOverlay(
          session && isHandshakeFailure(msg)
            ? `Couldn't connect to Genie after ${attempt} tries. Its servers may be busy; please try again in a moment.`
            : msg,
          { error: true },
        );
        return;
      }
    }
  }

  // The first decoded frame marks the session as live.
  function watchFirstFrame() {
    const onFrame = () => { if (state.session) state.session.onFirstFrame(); };
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      const arm = () => el.video.requestVideoFrameCallback(() => { onFrame(); });
      el.video.addEventListener("loadedmetadata", arm);
      el.video.addEventListener("emptied", arm);
      arm();
    }
    el.video.addEventListener("playing", onFrame);
  }
  watchFirstFrame();

  el.start.addEventListener("click", startSession);
  el.end.addEventListener("click", () => state.session && state.session.end());

  // Closing or reloading the tab: stop generation so the session isn't billed until its cap.
  window.addEventListener("pagehide", () => {
    const s = state.session;
    if (s && s.conn && !s.finished) { try { s.conn.cancel(); } catch (_) { /* ignore */ } }
  });

  el.eventForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.eventInput.value.trim();
    if (!text || !state.live || !state.session) return;
    state.session.send({ event_type: "input", content: [{ type: "text", text }] });
    el.eventInput.value = "";
    el.stage.focus();
  });

  el.mute.addEventListener("click", () => {
    state.muted = !state.muted;
    el.video.muted = state.muted;
    el.mute.textContent = state.muted ? "Unmute" : "Mute";
  });

  el.snap.addEventListener("click", () => {
    const v = el.video;
    if (!v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `world-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  });

  el.fs.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else el.stage.requestFullscreen && el.stage.requestFullscreen();
  });

  /* ------------------------------------------------------------------ recordings */

  const recGrid = $("rec-grid");
  const recEmpty = $("rec-empty");
  const recCount = $("rec-count");
  const recTpl = $("rec-card");

  function updateRecCount() {
    const n = recGrid.querySelectorAll(".rec-card:not(.saving)").length;
    recEmpty.classList.toggle("hidden", recGrid.children.length > 0);
    recCount.textContent = n ? `${n} saved` : "";
  }

  function fmtWhen(rec) {
    const d = new Date(rec.created * 1000);
    const date = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `${date} · ${Math.round(rec.duration)} s`;
  }

  function recordingCard(rec) {
    const node = recTpl.content.firstElementChild.cloneNode(true);
    const video = node.querySelector("video");
    video.src = rec.url;
    if (rec.reference_url) video.poster = rec.reference_url;
    node.querySelector(".rec-prompt").textContent = rec.prompt;
    node.querySelector(".rec-prompt").title = rec.prompt;
    node.querySelector(".rec-when").textContent = fmtWhen(rec);
    const dl = node.querySelector(".rec-download");
    dl.href = rec.url + "?download=1";
    dl.setAttribute("download", `world-${rec.id}.mp4`);
    node.querySelector(".rec-delete").addEventListener("click", async () => {
      if (!confirm("Delete this recording? This cannot be undone.")) return;
      // Release the file so the server can delete it (Windows locks open files).
      video.pause(); video.removeAttribute("src"); video.load();
      const res = await fetch(`/api/recordings/${encodeURIComponent(rec.id)}`, { method: "DELETE" });
      if (res.ok) { node.remove(); updateRecCount(); }
      else { video.src = rec.url; alert((await res.json().catch(() => ({}))).error || "Could not delete."); }
    });
    return node;
  }

  async function uploadRecording(sessionId, blob, duration) {
    const saving = document.createElement("article");
    saving.className = "rec-card saving";
    saving.innerHTML = '<div class="spinner"></div><span class="small">Saving recording</span>';
    recGrid.prepend(saving);
    updateRecCount();
    try {
      const form = new FormData();
      form.append("session_id", sessionId);
      form.append("duration", duration.toFixed(2));
      form.append("video", blob, blob.type.includes("mp4") ? "session.mp4" : "session.webm");
      const res = await fetch("/api/recordings", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      const card = recordingCard(data);
      card.classList.add("fresh");
      saving.replaceWith(card);
    } catch (err) {
      saving.innerHTML = "";
      saving.textContent = `Recording not saved: ${err.message}`;
      setTimeout(() => { saving.remove(); updateRecCount(); }, 6000);
    }
    updateRecCount();
  }

  async function loadRecordings() {
    try {
      const res = await fetch("/api/recordings");
      const list = await res.json();
      recGrid.replaceChildren(...list.map(recordingCard));
    } catch (_) { /* ignore */ }
    updateRecCount();
  }
  loadRecordings();

  /* ------------------------------------------------------------------ input */

  function keyDown(input) {
    if (!state.live || state.held.has(input)) return;
    state.held.add(input);
    document.querySelectorAll(`.key[data-input="${input}"]`).forEach((b) => b.classList.add("held"));
    if (state.session) state.session.send({ event_type: "user_action", action: "key_down", input });
  }
  function keyUp(input) {
    if (!state.held.has(input)) return;
    state.held.delete(input);
    document.querySelectorAll(`.key[data-input="${input}"]`).forEach((b) => b.classList.remove("held"));
    if (state.session) state.session.send({ event_type: "user_action", action: "key_up", input });
  }
  function releaseAllKeys() { [...state.held].forEach(keyUp); }

  const typingTarget = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

  window.addEventListener("keydown", (e) => {
    const input = KEY_MAP[e.code];
    if (!input || !state.live || typingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (!e.repeat) keyDown(input);
  });
  window.addEventListener("keyup", (e) => {
    const input = KEY_MAP[e.code];
    if (input) keyUp(input);
  });
  window.addEventListener("blur", releaseAllKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAllKeys(); });
  el.stage.addEventListener("click", () => el.stage.focus());

  document.querySelectorAll(".key").forEach((btn) => {
    const input = btn.dataset.input;
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); keyDown(input); });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => btn.addEventListener(ev, () => keyUp(input)));
  });

  /* ------------------------------------------------------------------ Google Maps */

  // Parse "lat, lng" or a Google Maps URL such as
  //   https://www.google.com/maps/@48.8584,2.2945,3a,75y,90h,95t/...
  //   https://www.google.com/maps/place/.../@48.85,2.29,17z/data=...!3d48.8584!4d2.2945
  //   https://maps.google.com/?q=48.85,2.29
  function parseLocation(text) {
    const s = decodeURIComponent(text.trim());
    const num = "(-?\\d+(?:\\.\\d+)?)";
    let lat, lng, heading, pitch, fov;

    const pin = s.match(new RegExp(`!3d${num}!4d${num}`));
    const at = s.match(new RegExp(`@${num},${num}((?:,[\\d.]+[a-z])*)`));
    const q = s.match(new RegExp(`[?&](?:q|query|ll|viewpoint|cbll)=${num},\\s*${num}`));
    const plain = s.match(new RegExp(`^${num}\\s*[,\\s]\\s*${num}$`));

    if (pin) { lat = +pin[1]; lng = +pin[2]; }
    else if (at) { lat = +at[1]; lng = +at[2]; }
    else if (q) { lat = +q[1]; lng = +q[2]; }
    else if (plain) { lat = +plain[1]; lng = +plain[2]; }
    else return null;

    if (at && at[3]) {
      for (const part of at[3].split(",").filter(Boolean)) {
        const v = parseFloat(part), unit = part.slice(-1);
        if (unit === "h") heading = v;
        else if (unit === "t") pitch = v - 90;   // Maps "tilt": 90 = horizon
        else if (unit === "y") fov = v;
      }
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng, heading, pitch, fov };
  }

  window.initMap = async function initMap() {
    const start = { lat: 48.8583701, lng: 2.2944813 }; // Eiffel Tower
    const infoEl = $("pano-info");
    let placeName = "Champ de Mars, Paris";

    const panorama = new google.maps.StreetViewPanorama($("pano"), {
      position: start,
      pov: { heading: 300, pitch: 5 },
      zoom: 1,
      addressControl: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      enableCloseButton: false,
      keyboardShortcuts: false, // otherwise Street View grabs WASD and the arrow keys
    });
    const map = new google.maps.Map($("map"), {
      center: start, zoom: 15, streetViewControl: false, mapTypeControl: false,
      fullscreenControl: false, clickableIcons: false,
    });
    map.setStreetView(panorama);
    const marker = new google.maps.Marker({ map, position: start });
    const sv = new google.maps.StreetViewService();

    function describe() {
      const loc = panorama.getLocation();
      const desc = loc && loc.description;
      if (desc) placeName = desc;
      infoEl.textContent = placeName || "Look around, then use this view.";
    }

    async function goTo(target, pov, name) {
      try {
        const { data } = await sv.getPanorama({
          location: target, radius: 100,
          preference: google.maps.StreetViewPreference.NEAREST,
          source: google.maps.StreetViewSource.OUTDOOR,
        });
        if (name) placeName = name;
        panorama.setPano(data.location.pano);
        if (pov) panorama.setPov({
          heading: pov.heading ?? panorama.getPov().heading,
          pitch: pov.pitch ?? 0,
        });
        if (pov && pov.fov) panorama.setZoom(Math.max(0, Math.log2(180 / pov.fov)));
        map.panTo(data.location.latLng);
        infoEl.textContent = name || data.location.description || "Look around, then use this view.";
      } catch (_) {
        infoEl.textContent = "No Street View imagery near there. Try a nearby road.";
      }
    }

    panorama.addListener("position_changed", () => {
      const p = panorama.getPosition();
      if (p) { marker.setPosition(p); }
    });
    panorama.addListener("pano_changed", describe);
    map.addListener("click", (e) => goTo(e.latLng, null, null));

    // Place search: new PlaceAutocompleteElement, falling back to legacy Autocomplete.
    const host = $("place-search");
    try {
      const { PlaceAutocompleteElement } = await google.maps.importLibrary("places");
      const pac = new PlaceAutocompleteElement();
      pac.setAttribute("placeholder", "Search a place (e.g. Times Square)");
      host.appendChild(pac);
      pac.addEventListener("gmp-select", async ({ placePrediction }) => {
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ["displayName", "formattedAddress", "location"] });
        if (place.location) goTo(place.location, null, place.displayName || place.formattedAddress);
      });
    } catch (_) {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Search a place (e.g. Times Square)";
      host.appendChild(input);
      const ac = new google.maps.places.Autocomplete(input, { fields: ["geometry", "name"] });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        if (place.geometry) goTo(place.geometry.location, null, place.name);
      });
    }

    $("coords-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const loc = parseLocation($("coords-input").value);
      if (!loc) { infoEl.textContent = "Couldn't read that. Use “lat, lng” or a google.com/maps link."; return; }
      goTo({ lat: loc.lat, lng: loc.lng }, loc, null);
    });

    $("use-view").addEventListener("click", async () => {
      const btn = $("use-view");
      const pos = panorama.getPosition();
      if (!pos) return;
      const pov = panorama.getPov();
      const fov = Math.min(120, Math.max(10, 180 / Math.pow(2, panorama.getZoom() || 0)));
      btn.disabled = true; btn.textContent = "Capturing…";
      try {
        const res = await fetch("/api/streetview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: pos.lat(), lng: pos.lng(), heading: pov.heading, pitch: pov.pitch, fov }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Capture failed");
        const where = placeName || `${pos.lat().toFixed(5)}, ${pos.lng().toFixed(5)}`;
        setReference(data.image, `Street View · ${where}${data.date ? " · " + data.date : ""}`);

        // Suggest a "walk this real place" prompt unless the user wrote their own.
        const current = el.prompt.value.trim();
        if (!current || current === state.autoPrompt) {
          state.autoPrompt =
            `Immersive first-person POV standing on the sidewalk at ${where}, a real-world street ` +
            `exactly as in the reference image. Photorealistic, natural lighting, eye-level camera, ambient city sounds.`;
          el.prompt.value = state.autoPrompt;
        }
      } catch (err) {
        infoEl.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = "Use this view";
      }
    });

    window.__mapsPicker = {
      refresh() {
        google.maps.event.trigger(map, "resize");
        google.maps.event.trigger(panorama, "resize");
      },
    };
    describe();
  };

  // Load the Maps JavaScript API after initMap exists (this file is a deferred module).
  if (CFG.mapsKey) {
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(CFG.mapsKey) +
      "&v=weekly&libraries=places&loading=async&callback=initMap";
    document.head.appendChild(s);
  }
})();
