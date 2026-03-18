# Islamic Media Discovery

A web app for discovering, classifying, and curating Muslim-themed media (movies, TV series, YouTube shows, documentaries) with a focus on Islamic finance content. Uses Claude CLI as the AI backend.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Python 3](https://www.python.org/) (3.9+)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (`claude.cmd` must be available on your PATH and authenticated)

## Setup

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Install backend dependencies

```bash
pip install flask flask-cors
```

### 3. Create a `.env` file

```bash
cp .env.example .env
```

Or create `.env` manually in the project root:

```
VITE_ANTHROPIC_API_KEY=your-api-key-here
```

> **Note:** The `.env` file is currently tracked by git. You should add it to `.gitignore` to avoid leaking your API key.

## Running the App

You need **two terminals** — one for the backend, one for the frontend.

### Terminal 1: Start the Python backend (port 5000)

```bash
python src/backend.py
```

This starts a Flask server at `http://localhost:5000` that proxies discovery requests through the Claude CLI.

### Terminal 2: Start the React frontend

```bash
npm run dev
```

This starts the Vite dev server (typically at `http://localhost:5173`).

Open the URL shown in the terminal to use the app.

## How It Works

1. **Search tab** — Enter a topic (e.g., "Islamic finance in media"). The frontend sends the prompt to the Flask backend.
2. **Backend** — Calls `claude.cmd` via subprocess to discover media entries, then optionally makes a second call to convert the response to structured JSON.
3. **Media Library tab** — Browse, filter, sort, and review discovered entries. Change statuses (New → Reviewed → Approved/Rejected) and add notes.
4. **Transcripts / Islamic Finance tabs** — Planned features (coming soon).

## Project Structure

```
src/
  App.tsx        # Full React frontend (types, services, hooks, UI components)
  backend.py     # Flask API server that shells out to Claude CLI
  main.tsx       # React entry point
  App.css        # Styles
  index.css      # Global styles (Tailwind)
```

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Vite 7
- **Backend:** Python Flask, Claude CLI (subprocess)
