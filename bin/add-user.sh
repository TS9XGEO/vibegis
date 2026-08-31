#!/usr/bin/env bash
# Create or update a user account (upsert by username). Needed once to
# bootstrap the first admin — after that, use the in-app admin screen.
# Usage: bin/add-user.sh <username> <password> <admin|viewer> [premium]
set -euo pipefail
[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || { echo "Usage: bin/add-user.sh <username> <password> <admin|viewer> [premium]" >&2; exit 1; }
cd "$(dirname "$0")/.."
docker compose exec -T upload-api python -c '
import sys, bcrypt
from sqlalchemy import text
from app import engine

username, password, role = sys.argv[1], sys.argv[2], sys.argv[3]
premium = len(sys.argv) > 4 and sys.argv[4].lower() in ("1", "true", "yes", "premium")
if role not in ("admin", "viewer"):
    sys.exit(f"role must be admin or viewer, got {role!r}")
pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
with engine().begin() as conn:
    conn.execute(text(
        "INSERT INTO users (username, password_hash, role, premium) VALUES (:u, :p, :r, :pr) "
        "ON CONFLICT (username) DO UPDATE SET "
        "password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, premium = EXCLUDED.premium"
    ), {"u": username, "p": pw_hash, "r": role, "pr": premium})
print(f"OK: {username} ({role}{\", premium\" if premium else \"\"})")
' "$1" "$2" "$3" "${4:-}"
