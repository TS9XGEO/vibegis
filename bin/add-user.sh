#!/usr/bin/env bash
# Create or update a user account (upsert by username). Needed once to
# bootstrap the first admin — after that, use the in-app admin screen.
# Usage: bin/add-user.sh <username> <password> <admin|viewer> [free|pro|premium]
set -euo pipefail
[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || { echo "Usage: bin/add-user.sh <username> <password> <admin|viewer> [free|pro|premium]" >&2; exit 1; }
cd "$(dirname "$0")/.."
docker compose exec -T upload-api python -c '
import sys, bcrypt
from sqlalchemy import text
from app import engine

username, password, role = sys.argv[1], sys.argv[2], sys.argv[3]
tier = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "free"
if role not in ("admin", "viewer"):
    sys.exit(f"role must be admin or viewer, got {role!r}")
if tier not in ("free", "pro", "premium"):
    sys.exit(f"tier must be free, pro or premium, got {tier!r}")
pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
with engine().begin() as conn:
    conn.execute(text(
        "INSERT INTO userdb.users (username, password_hash, role, subscription_tier) VALUES (:u, :p, :r, :t) "
        "ON CONFLICT (username) DO UPDATE SET "
        "password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, subscription_tier = EXCLUDED.subscription_tier"
    ), {"u": username, "p": pw_hash, "r": role, "t": tier})
suffix = f", {tier}" if tier != "free" else ""
print(f"OK: {username} ({role}{suffix})")
' "$1" "$2" "$3" "${4:-}"
