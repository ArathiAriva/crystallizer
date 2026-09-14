#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

VENV_DIR="../.venv"

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
  source "$VENV_DIR/bin/activate"
  pip install -q -r requirements.txt
else
  source "$VENV_DIR/bin/activate"
fi

exec uvicorn app.main:app --reload --port 8030
