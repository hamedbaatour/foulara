#!/bin/sh
# Run the real Lighthouse defaults, sequentially, and require 100 in every category.
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SITE_ORIGIN=${1:-http://localhost:4180}
REPORT_DIR="$PROJECT_DIR/audits/lighthouse"
mkdir -p "$REPORT_DIR"
while IFS='|' read -r AUDIT_NAME AUDIT_ROUTE AUDIT_PROFILE; do
  [ -n "$AUDIT_NAME" ] || continue
  printf 'Auditing %s\n' "$AUDIT_NAME"
  if [ "$AUDIT_PROFILE" = desktop ]; then
    npx --yes lighthouse@13.5.0 "$SITE_ORIGIN$AUDIT_ROUTE" --preset=desktop --chrome-flags='--headless --no-sandbox' --output=json --output=html --output-path="$REPORT_DIR/$AUDIT_NAME" --quiet
  else
    npx --yes lighthouse@13.5.0 "$SITE_ORIGIN$AUDIT_ROUTE" --chrome-flags='--headless --no-sandbox' --output=json --output=html --output-path="$REPORT_DIR/$AUDIT_NAME" --quiet
  fi
  python3 - "$REPORT_DIR" "$AUDIT_NAME" <<'PY'
import json,sys
from pathlib import Path
root,name=Path(sys.argv[1]),sys.argv[2]
for extension in ('json','html'):
    (root/(name+'.report.'+extension)).replace(root/(name+'.'+extension))
report=json.loads((root/(name+'.json')).read_text())
scores={key:round(value['score']*100) for key,value in report['categories'].items()}
print(name,scores)
if report.get('runtimeError') or any(value!=100 for value in scores.values()):
    raise SystemExit('Lighthouse check failed. Inspect the saved report before proceeding.')
PY
done <<'CASES'
home-mobile|/|mobile
home-desktop|/|desktop
product-mobile|/product/the-vintage-garden-greige|mobile
product-desktop|/product/the-vintage-garden-greige|desktop
shop-mobile|/shop|mobile
shop-desktop|/shop|desktop
collections-mobile|/collections|mobile
story-mobile|/story|mobile
contact-mobile|/contact|mobile
help-mobile|/help|mobile
privacy-mobile|/privacy|mobile
royal-blue-mobile|/product/the-vintage-garden-royal-blue|mobile
rosette-mobile|/product/rosette-yellow|mobile
shadha-mobile|/product/shadha-beige|mobile
french-product-mobile|/product/the-vintage-garden-greige?lang=fr|mobile
arabic-product-mobile|/product/the-vintage-garden-greige?lang=ar|mobile
CASES
