#!/bin/sh
# workbuddy-buddy hook entry. Privacy-first, non-blocking: projects the payload to
# structural fields only (see project.py) and always exits 0 so WorkBuddy is never
# slowed or blocked, even if the projector errors.
python3 "$(dirname "$0")/project.py" "$1" 2>/dev/null
exit 0
