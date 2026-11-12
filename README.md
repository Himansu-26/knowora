# Knowora – setup
1. Supabase: create project → SQL Editor → run supabase.sql. Authentication → Providers → Email → turn OFF "Confirm email" (easier testing).
2. Copy keys: Project Settings → API (URL, anon, service_role).
3. Google AI Studio → create Gemini API key.
4. Local test: npm install, copy .env.example to .env, fill it, run: node --env-file=.env server.js → open http://localhost:3000
5. GitHub: push this folder (never commit .env).
6. Render: New → Web Service → repo. Set Root Directory to the folder containing `package.json`, `server.js`, and the `public` folder (leave it blank if those are at the repository root). Confirm `public/index.html`, `public/app.js`, and `public/style.css` are committed to the selected branch. Build: `npm install`. Start: `npm start`. Add the environment variables from `.env.example` in Render's Environment settings.
7. Keep awake: free UptimeRobot monitor pinging https://YOUR-APP.onrender.com/health every 5 min.
