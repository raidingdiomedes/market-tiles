#!/usr/bin/env bash
# Makes the 1200 x 630 share images in public/share/ from the live site (or any base URL).
#   scripts/make-cards.sh [base url]
# Each card is the real view, drawn from real data, with the date of the snapshot printed on it.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-$(node -p "require('./site.config.json').origin")}"
node scripts/shoot.mjs "$BASE" public/share 1200x630 \
  "board.png=/?card=1" "flow.png=/flow/?card=1" "swarm.png=/swarm/?card=1" "pulse.png=/pulse/?card=1"
