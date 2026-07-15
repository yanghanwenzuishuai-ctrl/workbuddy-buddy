#!/bin/sh
# workbuddy-buddy approval hook — fail-open by design (see approve.py).
python3 "$(dirname "$0")/approve.py"
exit 0
