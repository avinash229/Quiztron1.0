# Quiztron

## Run locally

1. Install Node.js if it is not already installed.
2. Open PowerShell in this folder.
3. Install dependencies once:

   ```powershell
   npm.cmd install
   ```

4. Set a private administrator password of at least 12 characters, then start the server:

   ```powershell
   $env:QUIZ_ADMIN_USERNAME = "admin"
   $env:QUIZ_ADMIN_PASSWORD = "replace-with-a-private-password-of-12-or-more-characters"
   node server.js
   ```

   Replace the example password with your own unique password. The username defaults to `admin` if `QUIZ_ADMIN_USERNAME` is omitted. Never commit or share your password.

5. Open the quiz at <http://localhost:3000>.
6. Open the admin dashboard at <http://localhost:3000/admin> and sign in.

Keep the terminal open while using the site. Press `Ctrl+C` there to stop the server. If port 3000 is already in use, the server is already running; close that server with `Ctrl+C` in its terminal before starting it again.

Without `DATABASE_URL`, local development uses `data/rounds.json` and `data/results.json`. When `DATABASE_URL` is configured, quiz content and participant results are stored in PostgreSQL. Quiz rounds are copied from `data/rounds.json` the first time the database is initialized and are then managed in the admin dashboard.

## Free deployment with Render and Neon

The repository includes a Render Blueprint in `render.yaml`. This deploys the Node.js web service; create a PostgreSQL database separately (for example, on Neon) so data persists across app restarts.

1. Push this project to a GitHub repository. `node_modules`, `.env` files, and `data/results.json` are excluded by `.gitignore`. Do not commit credentials or participant results.
2. Create a PostgreSQL project on your database provider and copy its TLS-enabled connection string. Keep the connection string private.
3. In Render, create a new Blueprint instance from the GitHub repository and follow the prompts for `QUIZ_ADMIN_USERNAME`, `QUIZ_ADMIN_PASSWORD`, and `DATABASE_URL`.
4. Set `QUIZ_ADMIN_PASSWORD` to a unique password with at least 12 characters. Set `DATABASE_URL` to the PostgreSQL connection string. Render's Blueprint also sets `NODE_ENV=production`, `HOST=0.0.0.0`, and `QUIZ_COOKIE_SECURE=true`.
5. Deploy. The server creates its database tables and seeds the questions from `data/rounds.json` on first launch. Open the Render service's HTTPS URL; append `/admin` for the protected admin dashboard.
6. Test the public quiz and admin sign-in using the deployed HTTPS address. Do not share the admin password with participants.

Render's free web service may sleep when idle. Check current Render and database-provider plan limits before relying on the service for an event. The server currently uses in-memory admin sessions and login rate limits, so deploy it as a single app instance; server restarts sign out the admin. Existing local participant results are not uploaded; the deployed database starts with no participant results.

## Admin security

The admin API requires a signed-in session. Its `HttpOnly`, `SameSite=Strict` cookie expires after 8 hours, sign-in attempts are rate limited, and the admin password is never sent with quiz content. HTTPS deployments must set `QUIZ_COOKIE_SECURE=true`.
