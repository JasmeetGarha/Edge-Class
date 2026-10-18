import { useCallback, useEffect, useRef, useState } from "react";
import * as faceapi from "@vladmandic/face-api";
import { jsPDF } from "jspdf";
import "./App.css";

const MODEL_PATH = "/models";
const ROSTER_PATH = "/students/students.json";
const MATCH_THRESHOLD = 0.52; // Keep conservative to reduce incorrect identity matches.
const AWAY_THRESHOLD = 0.18;
const MIN_AWAY_SECONDS = 1;
const DETECTION_INTERVAL_MS = 300; // Slightly slower for more reliable processing on typical laptops.

function estimateHeadDirection(landmarks, faceBox) {
  const p = landmarks.positions;

  const eyeCenter = (indices) => ({
    x: indices.reduce((sum, i) => sum + p[i].x, 0) / indices.length,
    y: indices.reduce((sum, i) => sum + p[i].y, 0) / indices.length,
  });

  const leftEye = eyeCenter([36, 37, 38, 39, 40, 41]);
  const rightEye = eyeCenter([42, 43, 44, 45, 46, 47]);
  const nose = p[30];

  const eyeDistance = Math.max(
    1,
    Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y)
  );

  const yaw =
    (nose.x - (leftEye.x + rightEye.x) / 2) / eyeDistance;

  const faceHeight = Math.max(1, faceBox.height);
  const eyeY = (leftEye.y + rightEye.y) / 2;
  const pitch = (nose.y - eyeY) / faceHeight;

  if (Math.abs(yaw) > AWAY_THRESHOLD) {
    return yaw < 0 ? "Turned left" : "Turned right";
  }

  // Approximate only; this is not eye-gaze or attention detection.
  if (pitch < 0.22 || pitch > 0.44) {
    return pitch < 0.22 ? "Head tilted up" : "Head tilted down";
  }

  return "Facing front";
}

function formatTime(seconds = 0) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return [h, m, s].map((value) => String(value).padStart(2, "0")).join(":");
}

const STUDENT_DB_NAME = "edgeclass-local-db";
const STUDENT_STORE_NAME = "students";

function openStudentDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STUDENT_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STUDENT_STORE_NAME)) {
        db.createObjectStore(STUDENT_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local student database."));
  });
}

async function getSavedStudents() {
  const db = await openStudentDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STUDENT_STORE_NAME, "readonly");
    const request = transaction.objectStore(STUDENT_STORE_NAME).getAll();

    request.onsuccess = () => {
      resolve(request.result || []);
      db.close();
    };
    request.onerror = () => {
      reject(request.error || new Error("Could not read saved students."));
      db.close();
    };
  });
}

async function saveStudentLocally(student) {
  const db = await openStudentDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STUDENT_STORE_NAME, "readwrite");
    transaction.objectStore(STUDENT_STORE_NAME).put(student);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      const error = transaction.error || new Error("Could not save student.");
      db.close();
      reject(error);
    };
    transaction.onabort = () => {
      const error = transaction.error || new Error("Saving student was cancelled.");
      db.close();
      reject(error);
    };
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function loadImageFromSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The student photo could not be loaded."));
    image.src = source;
  });
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const animationRef = useRef(null);
  const processingRef = useRef(false);
  const lastFrameRef = useRef(0);
  const rosterRef = useRef([]);
  const sessionRef = useRef(null);
  const attendanceRef = useRef({});
  const tracksRef = useRef({});
  const previousObservationRef = useRef({});
  const lastSeenRef = useRef({});
  const modelsLoadedRef = useRef(false);
  const enrollmentVideoRef = useRef(null);
  const enrollmentStreamRef = useRef(null);

  const [roster, setRoster] = useState([]);
  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentImage, setNewStudentImage] = useState(null);
  const [newStudentPreview, setNewStudentPreview] = useState("");
  const [savingStudent, setSavingStudent] = useState(false);
  const [enrollmentCameraOn, setEnrollmentCameraOn] = useState(false);
  const [enrollmentMessage, setEnrollmentMessage] = useState("");
  const [session, setSession] = useState(null);
  const [attendance, setAttendance] = useState({});
  const [durations, setDurations] = useState({});
  const [cameraOn, setCameraOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Ready to start a session.");
  const [faceCount, setFaceCount] = useState(0);

  const updateAttendance = useCallback((next) => {
    attendanceRef.current = next;
    setAttendance(next);
  }, []);

  useEffect(() => {
    if (enrollmentCameraOn && enrollmentVideoRef.current && enrollmentStreamRef.current) {
      enrollmentVideoRef.current.srcObject = enrollmentStreamRef.current;
      enrollmentVideoRef.current.play().catch((error) => {
        console.warn("Could not play enrollment camera preview:", error);
      });
    }
  }, [enrollmentCameraOn]);

  useEffect(() => {
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      enrollmentStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function loadModelsAndRoster() {
    if (!modelsLoadedRef.current) {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_PATH),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_PATH),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_PATH),
      ]);
      modelsLoadedRef.current = true;
    }

    const response = await fetch(ROSTER_PATH);
    if (!response.ok) {
      throw new Error(`Could not load ${ROSTER_PATH} (HTTP ${response.status}).`);
    }

    const staticRecords = await response.json();
    if (!Array.isArray(staticRecords)) {
      throw new Error("students.json must contain an array of students.");
    }

    // Students added from the UI are stored in this browser's IndexedDB.
    // They are merged with the original public/students/students.json roster.
    const savedRecords = await getSavedStudents();
    const byId = new Map();

    for (const student of staticRecords) byId.set(student.id, student);
    for (const student of savedRecords) byId.set(student.id, student);

    const records = Array.from(byId.values());
    if (records.length === 0) {
      throw new Error("No students found. Add a student or populate students.json.");
    }

    const prepared = [];
    for (const student of records) {
      if (!student.id || !student.name || !(student.photoDataUrl || student.photo)) {
        console.warn("Skipping invalid student record:", student);
        continue;
      }

      const photoSource = student.photoDataUrl || student.photo;

      try {
        const image = await loadImageFromSource(photoSource);
        const result = await faceapi
          .detectSingleFace(
            image,
            new faceapi.TinyFaceDetectorOptions({
              inputSize: 608,
              scoreThreshold: 0.25,
            })
          )
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (!result) {
          console.warn(`No face found in reference photo: ${student.id}`);
          continue;
        }

        prepared.push({ ...student, descriptor: result.descriptor });
      } catch (photoError) {
        console.error(`Could not load/process photo for ${student.name}:`, photoError);
      }
    }

    if (prepared.length === 0) {
      throw new Error(
        "No usable reference faces were found. Check photo paths and use clear, front-facing photos."
      );
    }

    rosterRef.current = prepared;
    setRoster(prepared.map(({ descriptor, ...student }) => student));

    const skipped = records.length - prepared.length;
    setMessage(
      `Loaded ${prepared.length} student face profile(s)` +
        (skipped ? `; ${skipped} photo(s) could not be processed.` : ".")
    );
  }

  async function startEnrollmentCamera() {
    try {
      setEnrollmentMessage("");

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access requires localhost or HTTPS.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      enrollmentStreamRef.current = stream;

      if (enrollmentVideoRef.current) {
        enrollmentVideoRef.current.srcObject = stream;
        await enrollmentVideoRef.current.play();
      }

      setEnrollmentCameraOn(true);
      setEnrollmentMessage("Camera ready. Position one student's face and click Capture photo.");
    } catch (error) {
      console.error("Could not start enrollment camera:", error);
      setEnrollmentMessage(`Could not open camera: ${error.message}`);
    }
  }

  function stopEnrollmentCamera() {
    enrollmentStreamRef.current?.getTracks().forEach((track) => track.stop());
    enrollmentStreamRef.current = null;

    if (enrollmentVideoRef.current) {
      enrollmentVideoRef.current.pause();
      enrollmentVideoRef.current.srcObject = null;
    }

    setEnrollmentCameraOn(false);
  }

  function captureEnrollmentPhoto() {
    const video = enrollmentVideoRef.current;

    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      setEnrollmentMessage("Wait until the camera preview is ready, then capture again.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      setEnrollmentMessage("Could not capture the photo. Please try again.");
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Store a compressed image directly in the local browser database.
    const photoDataUrl = canvas.toDataURL("image/jpeg", 0.88);
    setNewStudentPreview(photoDataUrl);
    setNewStudentImage({ captured: true });
    setEnrollmentMessage("Photo captured. Review it below, then save the student.");
  }

  async function handleAddStudent(event) {
    event.preventDefault();

    if (sessionRef.current) {
      setEnrollmentMessage("End the current attendance session before adding a student.");
      return;
    }

    const name = newStudentName.trim();
    if (!name || !newStudentImage || !newStudentPreview) {
      setEnrollmentMessage("Enter the student's name and capture a clear photo.");
      return;
    }

    try {
      setSavingStudent(true);
      setEnrollmentMessage("Checking the photo and saving locally...");

      // Ensure recognition models are available before creating the face profile.
      if (!modelsLoadedRef.current) {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_PATH),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_PATH),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_PATH),
        ]);
        modelsLoadedRef.current = true;
      }

      const image = await loadImageFromSource(newStudentPreview);
      const result = await faceapi
        .detectSingleFace(
          image,
          new faceapi.TinyFaceDetectorOptions({
            inputSize: 608,
            scoreThreshold: 0.25,
          })
        )
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!result) {
        setEnrollmentMessage(
          "No face was detected in this photo. Choose a clear, front-facing image with one person."
        );
        return;
      }

      // Load existing roster first so the duplicate-ID check includes static and saved students.
      await loadModelsAndRoster();

      const duplicate = rosterRef.current.some(
        (student) => student.name.trim().toLowerCase() === name.toLowerCase()
      );
      if (duplicate) {
        setEnrollmentMessage(
          "A student with this name already exists. Use a distinct name or check the existing roster."
        );
        return;
      }

      // Generate the next short sequential ID, e.g. STU001, STU002, STU003.
      // Consider both the JSON roster and students already saved in IndexedDB.
      const allExistingIds = new Set(
        rosterRef.current.map((student) => String(student.id || ""))
      );

      let nextNumber = 1;
      while (allExistingIds.has(`STU${String(nextNumber).padStart(3, "0")}`)) {
        nextNumber += 1;
      }

      const id = `STU${String(nextNumber).padStart(3, "0")}`;
      const savedStudent = {
        id,
        name,
        photoDataUrl: newStudentPreview,
        createdAt: new Date().toISOString(),
      };

      // The photo and student record persist in IndexedDB on this browser/device.
      await saveStudentLocally(savedStudent);

      // Keep the new descriptor ready immediately; it will also be recomputed next time.
      rosterRef.current = [
        ...rosterRef.current,
        { ...savedStudent, descriptor: result.descriptor },
      ];
      setRoster(
        rosterRef.current.map(({ descriptor, ...student }) => student)
      );

      setNewStudentName("");
      setNewStudentImage(null);
      setNewStudentPreview("");
      setEnrollmentMessage(`${name} was saved locally and is ready for the next session.`);
      setMessage(`Added student: ${name}`);
    } catch (error) {
      console.error("Could not add student:", error);
      setEnrollmentMessage(`Could not save student: ${error.message}`);
    } finally {
      setSavingStudent(false);
    }
  }

  function findMatch(descriptor, alreadyMatched) {
    let best = null;
    let bestDistance = Infinity;

    for (const student of rosterRef.current) {
      if (alreadyMatched.has(student.id)) continue;

      const distance = faceapi.euclideanDistance(
        descriptor,
        student.descriptor
      );

      if (distance < bestDistance) {
        best = student;
        bestDistance = distance;
      }
    }

    if (!best || bestDistance > MATCH_THRESHOLD) {
      return { student: null, distance: bestDistance };
    }

    return { student: best, distance: bestDistance };
  }

  async function startSession() {
    if (sessionRef.current || loading) return;

    try {
      setLoading(true);
      setMessage("Loading local AI models and student photos...");

      await loadModelsAndRoster();

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access requires localhost or HTTPS in a supported browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: false,
      });

      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      const newSession = {
        id: crypto.randomUUID?.() || String(Date.now()),
        startedAt: new Date().toISOString(),
      };

      sessionRef.current = newSession;
      setSession(newSession);
      updateAttendance({});
      setDurations({});
      tracksRef.current = {};
      previousObservationRef.current = {};
      lastSeenRef.current = {};
      processingRef.current = false;
      lastFrameRef.current = 0;

      setCameraOn(true);
      setMessage("Session active. Check the labels and review attendance before finalising.");
      animationRef.current = requestAnimationFrame(processFrames);
    } catch (error) {
      console.error(error);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      sessionRef.current = null;
      setSession(null);
      setCameraOn(false);
      setMessage(`Could not start: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function processFrames(timestamp) {
    if (!sessionRef.current) return;

    // Schedule the next frame; the processing guard prevents overlapping inference.
    animationRef.current = requestAnimationFrame(processFrames);

    if (timestamp - lastFrameRef.current < DETECTION_INTERVAL_MS) return;
    if (processingRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || video.readyState < 2 || !canvas) return;

    processingRef.current = true;
    const previousFrameTime = lastFrameRef.current;
    lastFrameRef.current = timestamp;

    try {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, width, height);

      const results = await faceapi
        .detectAllFaces(
          video,
          new faceapi.TinyFaceDetectorOptions({
            inputSize: 608,
            scoreThreshold: 0.25,
          })
        )
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (!sessionRef.current) return;

      setFaceCount(results.length);

      const matchedThisFrame = new Set();
      const now = performance.now();
      const deltaSeconds = Math.min(
        0.5,
        Math.max(0, (timestamp - previousFrameTime) / 1000)
      );

      const nextAttendance = { ...attendanceRef.current };
      const tracks = { ...tracksRef.current };
      const previous = { ...previousObservationRef.current };
      const lastSeen = { ...lastSeenRef.current };

      for (const result of results) {
        const box = result.detection.box;
        const matchResult = findMatch(result.descriptor, matchedThisFrame);
        const student = matchResult.student;
        let label = "Unknown face";
        let direction = "Not available";

        if (student) {
          label = student.name;
          matchedThisFrame.add(student.id);
          direction = estimateHeadDirection(result.landmarks, box);

          const existing = nextAttendance[student.id] || {
            studentId: student.id,
            name: student.name,
            status: "Present",
            firstSeenAt: new Date().toISOString(),
            confidenceDistance: matchResult.distance,
          };

          // A successful match marks the student present immediately.
          nextAttendance[student.id] = {
            ...existing,
            studentId: student.id,
            name: student.name,
            status: "Present",
            confidenceDistance: matchResult.distance,
            lastSeenAt: new Date().toISOString(),
            direction,
          };

          if (!tracks[student.id]) {
            tracks[student.id] = {
              awaySeconds: 0,
              awayStreak: 0,
              lastSeen: now,
            };
          }

          const track = { ...tracks[student.id] };
          const prior = previous[student.id];
          const isAway = direction !== "Facing front";

          if (isAway && prior?.away) {
            track.awayStreak += deltaSeconds;
            if (track.awayStreak >= MIN_AWAY_SECONDS) {
              track.awaySeconds += deltaSeconds;
            }
          } else if (isAway) {
            track.awayStreak = 0;
          } else {
            track.awayStreak = 0;
          }

          track.lastSeen = now;
          tracks[student.id] = track;
          previous[student.id] = { away: isAway, time: now };
          lastSeen[student.id] = now;

          console.debug(
            `[EdgeClass] Matched ${student.name}; distance=${matchResult.distance.toFixed(3)}`
          );
        } else {
          console.debug(
            `[EdgeClass] Unknown face; closest distance=${
              Number.isFinite(matchResult.distance)
                ? matchResult.distance.toFixed(3)
                : "n/a"
            }`
          );
        }

        ctx.strokeStyle = student ? "#36d399" : "#fbbf24";
        ctx.lineWidth = Math.max(2, width / 400);
        ctx.strokeRect(box.x, box.y, box.width, box.height);

        const text = student
          ? `${label} · ${direction}`
          : `${label} (${Number.isFinite(matchResult.distance) ? matchResult.distance.toFixed(2) : "—"})`;

        ctx.font = `${Math.max(14, width / 75)}px sans-serif`;
        const textWidth = ctx.measureText(text).width;
        const labelY = Math.max(0, box.y - 30);

        ctx.fillStyle = student ? "#047857" : "#92400e";
        ctx.fillRect(box.x, labelY, textWidth + 12, 26);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(text, box.x + 6, labelY + 18);
      }

      // A short missed frame does not remove attendance. Only sightings count here;
      // do not infer absence from a person turning away or leaving the camera view.
      tracksRef.current = tracks;
      previousObservationRef.current = previous;
      lastSeenRef.current = lastSeen;
      updateAttendance(nextAttendance);
      setDurations(
        Object.fromEntries(
          Object.entries(tracks).map(([id, track]) => [id, track.awaySeconds])
        )
      );
    } catch (error) {
      console.error("Face processing error:", error);
      setMessage(`AI processing error: ${error.message}`);
    } finally {
      processingRef.current = false;
    }
  }

  function endSession() {
    if (!sessionRef.current) return;

    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);

    const endedAt = new Date().toISOString();
    const finalAttendance = {};

    for (const student of rosterRef.current) {
      const record = attendanceRef.current[student.id];

      finalAttendance[student.id] = {
        studentId: student.id,
        name: student.name,
        status: record?.status || "Absent — review",
        firstSeenAt: record?.firstSeenAt || null,
        lastSeenAt: record?.lastSeenAt || null,
        awaySeconds: tracksRef.current[student.id]?.awaySeconds || 0,
      };
    }

    const report = {
      sessionId: sessionRef.current.id,
      startedAt: sessionRef.current.startedAt,
      endedAt,
      students: Object.values(finalAttendance),
    };

    try {
      const history = JSON.parse(
        localStorage.getItem("edgeclass-reports") || "[]"
      );
      history.push(report);
      localStorage.setItem("edgeclass-reports", JSON.stringify(history));
    } catch (error) {
      console.error("Could not save report history:", error);
      setMessage("Session ended, but report history could not be saved in this browser.");
    }

    sessionRef.current = null;
    setSession(null);
    updateAttendance(finalAttendance);
    setMessage("Session ended. Review attendance and export the PDF.");
  }

  function exportPDF() {
    const doc = new jsPDF();
    const started = session?.startedAt || "Previous session";
    const ended = new Date().toISOString();

    doc.setFontSize(18);
    doc.text("EdgeClass Attendance Report", 14, 18);
    doc.setFontSize(10);
    doc.text(`Session started: ${started}`, 14, 28);
    doc.text(`Report generated: ${ended}`, 14, 35);
    doc.text(
      "Head direction is an approximate estimate, not proof of inattention.",
      14,
      42
    );

    let y = 54;
    doc.setFont(undefined, "bold");
    doc.text("Student ID", 14, y);
    doc.text("Name", 45, y);
    doc.text("Attendance", 100, y);
    doc.text("Off-front", 153, y);
    y += 7;
    doc.setFont(undefined, "normal");

    for (const student of roster) {
      if (y > 275) {
        doc.addPage();
        y = 20;
      }

      const record = attendanceRef.current[student.id] || {};
      const seconds = tracksRef.current[student.id]?.awaySeconds || 0;

      doc.text(String(student.id).slice(0, 18), 14, y);
      doc.text(String(student.name).slice(0, 28), 45, y);
      doc.text(String(record.status || "Not marked").slice(0, 25), 100, y);
      doc.text(formatTime(seconds), 153, y);
      y += 7;
    }

    doc.save("edgeclass-attendance-report.pdf");
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">ON-DEVICE COMPUTER VISION</p>
          <h1>EdgeClass</h1>
          <p className="muted">Classroom attendance workspace</p>
        </div>
        <span className={`status ${cameraOn ? "online" : ""}`}>
          {cameraOn ? "Session active" : "Session stopped"}
        </span>
      </header>

      <section className="stats">
        <article className="stat">
          <span>Enrolled students</span>
          <strong>{roster.length}</strong>
        </article>
        <article className="stat">
          <span>Faces detected</span>
          <strong>{faceCount}</strong>
        </article>
        <article className="stat">
          <span>Present sightings</span>
          <strong>
            {Object.values(attendance).filter((record) => record.status === "Present").length}
          </strong>
        </article>
      </section>

      <section className="panel">
        <h2>Live classroom camera</h2>
        <p className="muted">
          Matching and orientation estimation run in your browser.
        </p>

        <div className="camera-frame">
          <video ref={videoRef} autoPlay muted playsInline />
          <canvas ref={canvasRef} />
          {!cameraOn && (
            <div className="camera-placeholder">
              <strong>Camera stopped</strong>
              <span>Start a session to begin detection.</span>
            </div>
          )}
        </div>

        <div className="camera-actions">
          {!session ? (
            <button
              className="primary"
              disabled={loading}
              onClick={startSession}
            >
              {loading ? "Loading AI..." : "Start class session"}
            </button>
          ) : (
            <button className="danger" onClick={endSession}>
              End class session
            </button>
          )}

          <button
            className="secondary"
            onClick={exportPDF}
            disabled={roster.length === 0}
          >
            Export PDF report
          </button>
        </div>

        <p className="message" role="status">{message}</p>
      </section>

      <section className="panel roster-panel">
        <div className="panel-heading">
          <div>
            <h2>Add a new student</h2>
            <p className="muted">
              Add a name and a clear face photo. The record is saved on this browser for future sessions.
            </p>
          </div>
          <span className="pill">Local database</span>
        </div>

        <form className="enroll-form" onSubmit={handleAddStudent}>
          <label htmlFor="new-student-name">Student name</label>
          <input
            id="new-student-name"
            type="text"
            value={newStudentName}
            onChange={(event) => setNewStudentName(event.target.value)}
            placeholder="Enter student name"
            maxLength={80}
            required
            disabled={savingStudent || Boolean(session)}
          />

          <label>Student photo</label>

          {enrollmentCameraOn ? (
            <div style={{ display: "grid", gap: 10 }}>
              <video
                ref={enrollmentVideoRef}
                autoPlay
                muted
                playsInline
                style={{
                  width: "100%",
                  maxWidth: 480,
                  aspectRatio: "4 / 3",
                  objectFit: "cover",
                  borderRadius: 10,
                  background: "#070b14",
                  border: "1px solid #34425b",
                }}
              />
              <div className="camera-actions">
                <button
                  className="primary"
                  type="button"
                  onClick={captureEnrollmentPhoto}
                  disabled={savingStudent}
                >
                  Capture photo
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={stopEnrollmentCamera}
                >
                  Close camera
                </button>
              </div>
            </div>
          ) : (
            <button
              className="secondary"
              type="button"
              onClick={startEnrollmentCamera}
              disabled={savingStudent || Boolean(session)}
            >
              Open camera to take photo
            </button>
          )}

          {newStudentPreview && (
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <img
                src={newStudentPreview}
                alt="Captured student photo preview"
                style={{
                  width: 120,
                  height: 120,
                  objectFit: "cover",
                  borderRadius: 10,
                  border: "1px solid #34425b",
                }}
              />
              <div style={{ display: "grid", gap: 8 }}>
                <span className="muted small">
                  Check that only one face is visible and clearly lit.
                </span>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setNewStudentImage(null);
                    setNewStudentPreview("");
                    setEnrollmentMessage("Photo cleared. Open the camera to take another.");
                  }}
                  disabled={savingStudent}
                >
                  Retake photo
                </button>
              </div>
            </div>
          )}

          <button
            className="primary"
            type="submit"
            disabled={savingStudent || Boolean(session)}
          >
            {savingStudent ? "Saving student..." : "Save student"}
          </button>

          {session && (
            <p className="message">
              End the current class session before changing the student roster.
            </p>
          )}
          {enrollmentMessage && (
            <p className="message" role="status">{enrollmentMessage}</p>
          )}
        </form>
      </section>

      <section className="panel roster-panel">
        <div className="panel-heading">
          <div>
            <h2>Attendance report</h2>
            <p className="muted">
              Unseen students need teacher review before finalisation.
            </p>
          </div>
        </div>

        {roster.map((student) => (
          <article className="student-row" key={student.id}>
            <img src={student.photoDataUrl || student.photo} alt={`Photo of ${student.name}`} />
            <div className="student-info">
              <strong>{student.name}</strong>
              <span className="muted small">{student.id}</span>
            </div>
            <span>{attendance[student.id]?.status || "Not marked"}</span>
            <span className="muted small">
              Off-front: {formatTime(durations[student.id] || 0)}
            </span>
          </article>
        ))}
      </section>

      <footer>
        Local-first prototype · Verify all attendance results manually.
        Head direction is approximate and is not a measure of attention.
      </footer>
    </main>
  );
}
