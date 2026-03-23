# SpeedAI Website Speed Analyzer

This app analyzes a URL with **Google PageSpeed Insights** and explains the main issues using **Gemini**.

## Setup
1. Copy environment variables:
   - From `server/.env.example` to `server/.env`
2. Set:
   - `PAGESPEED_API_KEY`
   - `GEMINI_API_KEY`
   - (optional) `GEMINI_MODEL` (defaults to `gemini-1.5-flash`)

## Run
1. Install dependencies:
   - `cd server`
   - `npm install`
2. Start the server:
   - `npm start`

Open: `http://localhost:3000`

## Notes
- API keys are used only on the server; they must not be placed in `public/` or browser code.
- The frontend is served from `public/`.

