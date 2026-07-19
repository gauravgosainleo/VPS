# AI Coursebook Generator — Dokploy/VPS edition

This project is the VPS replacement for the supplied Google Apps Script application. The v9.1 interface and generation flow are retained, while Google-only runtime services are replaced with:

- a Node.js HTTP server and browser-to-server RPC bridge;
- MySQL-backed dashboard/coursebook records;
- persistent filesystem job state, page backups, generated PDFs, and cache;
- the same OpenAI, Koenig RMS/employee-code, and GHL upload integrations;
- Docker and Docker Compose definitions suitable for Ubuntu and Dokploy.

The older sidebar HTML supplied with the source is not used by the v9.1 web app. `public/index.html` is the complete current interface.

## Dokploy deployment

1. Put this folder in a Git repository that Dokploy can access.
2. In Dokploy, create an **Application** and select **Dockerfile** as the build type.
3. Set the Dockerfile path to `Dockerfile` and the container port to `3000`.
4. Add a persistent volume mounted at `/app/data`. This is required for resume, page backups, and generated PDF links to survive redeploys.
5. Copy every required value from `.env.example` into Dokploy's Environment settings. Use the public HTTPS domain for `APP_URL`.
6. Ensure the application and the MySQL service share the same Dokploy internal network, so the `MYSQL_HOST` name resolves from the application container.
7. Add the domain in Dokploy, point it at port `3000`, enable HTTPS, and deploy.
8. Check `https://your-domain/healthz`; it should return an `ok: true` JSON response.

Dokploy supplies the reverse proxy and TLS certificate. Do not expose the container directly to the internet when a Dokploy domain is configured.

## Employee list

The searchable employee dropdown now reads from the MySQL `app_employees` table instead of Google Sheets. The app automatically creates this table. If it is empty, the interface safely switches to manual name and email entry.

For the initial migration, set `EMPLOYEES_JSON` in Dokploy as a JSON array of `{ "name", "email" }` objects. It is imported only when `app_employees` is empty. After that, manage employees in MySQL:

```sql
INSERT INTO app_employees (name, email, active)
VALUES ('Example User', 'user@example.com', 1);
```

Set `active=0` to hide an employee without deleting their record. When MySQL is not configured, `data/employees.json` remains available as a local development fallback only.

## MySQL storage

The supplied Dokploy MySQL service is configured through `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD`. On the first dashboard or coursebook-log operation, the application automatically creates:

- `app_spreadsheet_sheets`
- `app_spreadsheet_cells`
- `app_employees`

These tables replace the application's former Google Sheets usage. They hold the employee directory, dashboard history, resume metadata references, statuses, download records, and configured cost logs. The database user therefore needs `CREATE`, `SELECT`, `INSERT`, and `UPDATE` access to the configured database.

The password is intentionally absent from the repository and ZIP. Add it directly to Dokploy's Environment settings as `MYSQL_PASSWORD`.

## Docker Compose alternative

For a plain Ubuntu VPS:

```bash
cp .env.example .env
# Fill in .env, then:
docker compose up -d --build
```

The app will listen on `${APP_PORT:-3000}`. Put a reverse proxy with HTTPS in front of it for production.

## Data layout

All mutable data lives below `/app/data`:

- `files/` — generated PDF copies exposed through authenticated download links;
- `cache/` — expiring cache values;
- `spreadsheets/` — fallback local records when MySQL variables are not configured;
- `files/_job_states/` — resumable job state and per-page HTML/PDF-source backups;
- `employees.json` — local-development employee fallback when MySQL is disabled.

Back up the persistent volume as part of normal VPS backups.

## Security notes

- No API keys, database passwords, or integration passwords are stored in the source. Configure them only in Dokploy.
- Set `APP_USERNAME` and a strong `APP_PASSWORD`; generation endpoints can spend API credits.
- Rotate credentials that were previously embedded in Apps Script source if that source was shared.
- Keep `/app/data` on a private persistent volume and do not publish it as a static directory.

## Local verification

The server itself has no npm dependencies:

```bash
npm run check
npm start
```

Open `http://localhost:3000`. OpenAI/RMS/GHL operations require their environment variables; employee selection falls back to manual entry when no employee data is configured.
