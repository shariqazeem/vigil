# The clean URL

Warden runs on one VM: it keeps a SQLite file on disk, spawns `pm2` and `ssh` by name, and holds a
run open for minutes while it streams. None of that survives a serverless platform, so the app does
not move. What moves is the front door: this Vercel project is a reverse proxy — every path is
rewritten to the VM, server-sent events stream through it unchanged, and the owner cookie is set on
the clean host. `WARDEN_BASE_URL` on the VM names the clean host, so redirects and notification
links land there too.

    cd deploy/vercel-proxy && vercel --prod

Live: https://getwarden.vercel.app (the VM answers directly at https://warden.80.225.209.190.sslip.io).
