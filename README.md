# EdgeClass — Edge AI Classroom Attendance System

An AI-powered classroom attendance system that uses real-time facial recognition to automate attendance tracking and estimate student head direction, with locally processed video and downloadable attendance reports.

## Overview

**EdgeClass** is a browser-based classroom attendance application designed to simplify attendance management using computer vision and AI.

The system uses a webcam to detect and recognize registered students, record their attendance, and estimate how long they spend facing away from the front of the classroom. It also provides student registration and PDF report generation through a unified dashboard.

The project aims to demonstrate how edge-based AI can support classroom administration while reducing reliance on external cloud processing.

## Features

- **Real-time face detection:** Detects faces in the live classroom camera feed.
- **Facial recognition:** Matches detected faces against registered student records.
- **Automated attendance:** Records recognized students as present and identifies students not detected during the session.
- **Head-direction estimation:** Estimates whether a student is facing toward or away from the front of the classroom.
- **Off-front duration tracking:** Tracks estimated accumulated time spent facing away from the front.
- **Student registration:** Register students by capturing their photographs directly through a webcam.
- **Automatic student IDs:** Generates sequential student IDs in the format `STU001`, `STU002`, and so on.
- **Local persistence:** Stores newly registered student information using browser-side persistence.
- **PDF attendance reports:** Generates downloadable attendance reports containing student information and available session data.
- **Dashboard interface:** Displays the live classroom camera and student registration panels side by side, with the attendance report below.
- **Browser-based processing:** Performs supported AI processing locally in the browser using the configured models.

## Tech Stack

| Technology | Purpose |
|---|---|
| React | User interface |
| Vite | Development server and build tooling |
| JavaScript | Application logic |
| face-api.js / configured face-recognition library | Facial detection and recognition |
| HTML and CSS | Structure and styling |
| jsPDF | PDF report generation |
| Browser APIs | Webcam access and local persistence |

> **Note:** Verify the actual package names in `package.json` before publishing this README, especially the facial-recognition library and PDF-generation package.

## How It Works

1. **Initialize the system:** Load the application and the required AI models.
2. **Start the camera:** Grant webcam permission to display the live classroom feed.
3. **Detect and recognize faces:** Compare detected faces with the registered student database.
4. **Record attendance:** Mark recognized students as present during the session.
5. **Estimate head direction:** Track estimated head orientation and accumulated off-front duration where available.
6. **Register students:** Capture a new student's photograph, enter their name, and generate a student ID.
7. **Generate a report:** Export the session's attendance information as a downloadable PDF.

## Project Structure

The exact structure may vary depending on your implementation.

```text
EdgeClass/
├── public/
│   ├── models/             # AI model files
│   └── students/
│       └── students.json   # Initial student records
├── src/
│   ├── App.jsx             # Main application
│   ├── App.css             # Dashboard and component styling
│   └── index.css           # Global styles
├── index.html
├── package.json
├── package-lock.json
└── README.md
```

## Getting Started

### Prerequisites

- Node.js and npm
- A modern web browser
- A webcam
- The required AI model files
- The project's source code and dependencies

### Installation

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/EdgeClass.git
cd EdgeClass
```

Install the dependencies:

```bash
npm install
```

### Run the Application

Start the Vite development server:

```bash
npm run dev
```

Open the local URL printed in the terminal, usually:

```text
http://localhost:5173
```

Allow camera access when prompted.

> **Important:** Webcam access generally requires `localhost` or a secure HTTPS connection. Ensure the required model files are available at the paths expected by the application.

### Build for Production

```bash
npm run build
```

To preview the production build locally:

```bash
npm run preview
```

## Student Data and Privacy

EdgeClass is designed to support local processing and browser-side storage.

- The application uses registered student photographs for facial recognition.
- Newly registered student records are persisted through the configured browser-side storage mechanism.
- Facial recognition and head-direction estimates may be affected by lighting, camera positioning, occlusion, and model accuracy.
- Browser storage may be lost if the user clears site data or changes browsers or devices.
- Avoid publishing real student names, photographs, facial data, or other personally identifiable information in a public repository.

**Privacy note:** Facial recognition involves sensitive biometric information. Obtain appropriate consent and authorization before using the system with real students, follow applicable privacy requirements, and restrict access to attendance records.

## Limitations

- Recognition accuracy depends on image quality, lighting, camera angle, and the configured AI models.
- Students who are obscured or not visible to the camera may not be detected.
- Head direction is an estimate and should not be treated as proof of attention, engagement, or learning.
- A student marked absent may simply have been missed by the camera.
- Browser-side persistence is not a substitute for a centralized database or a secure backup system.
- The system should be tested in realistic classroom conditions before practical deployment.

## Future Improvements

Potential future enhancements include:

- Improved recognition accuracy in crowded classrooms.
- Configurable attendance sessions and session history.
- CSV and Excel report exports.
- Improved head-pose estimation and visualization.
- Administrative authentication and access control.
- Secure database integration and encrypted backups.
- Classroom-level analytics and attendance summaries.
- A review workflow for uncertain face matches and attendance records.

### Documentation Update

This project is maintained collaboratively.
## Contributors and Credits

### Research and Ideation

**Ketan Sudan** 

Responsible for research and ideation behind the project.

### Development

**Jasmeet Singh**

Responsible for application development and implementation.

## Disclaimer

EdgeClass is an educational and development project intended to demonstrate the use of AI and computer vision for classroom attendance management. It should not be used as the sole basis for disciplinary, academic, or other consequential decisions without appropriate human verification.

## License

Choose a license before distributing or accepting contributions to this project. If you intend to make the source code openly reusable, consider the [MIT License](https://opensource.org/license/mit).
