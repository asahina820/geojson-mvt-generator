#!/bin/bash
set -euo pipefail

# Lambda から RunTask の環境変数で渡される（未指定なら既定値）
LAYER_NAME="${LAYER_NAME:-data}"
MIN_ZOOM="${MIN_ZOOM:-0}"
MAX_ZOOM="${MAX_ZOOM:-14}"

echo "Downloading input..."

aws s3 cp "$INPUT_S3" /tmp/input.geojson

echo "Generating MVT..."

mkdir -p /tmp/tiles

tippecanoe \
  -e /tmp/tiles \
  -l "$LAYER_NAME" \
  -Z "$MIN_ZOOM" \
  -z "$MAX_ZOOM" \
  --drop-densest-as-needed \
  /tmp/input.geojson

echo "Packaging..."

cd /tmp/tiles
zip -r /tmp/output.zip .

echo "Uploading output..."

aws s3 cp /tmp/output.zip "$OUTPUT_S3"

echo "Done!"
