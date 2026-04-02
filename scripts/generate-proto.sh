#!/usr/bin/env bash
set -euo pipefail

PROTO_DIR="$(cd "$(dirname "$0")/../proto" && pwd)"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Node.js services that need generated gRPC code
NODE_SERVICES=(orchestrator zoom-bot browser-controller tts-service claude-wrapper persistence)

for service in "${NODE_SERVICES[@]}"; do
  OUT_DIR="$ROOT_DIR/services/$service/src/generated"
  mkdir -p "$OUT_DIR"

  npx grpc_tools_node_protoc \
    --js_out=import_style=commonjs,binary:"$OUT_DIR" \
    --grpc_out=grpc_js:"$OUT_DIR" \
    --proto_path="$PROTO_DIR" \
    "$PROTO_DIR"/*.proto

  echo "Generated gRPC code for $service"
done

# Python STT service
PY_OUT_DIR="$ROOT_DIR/services/stt-service/src/generated"
mkdir -p "$PY_OUT_DIR"
touch "$PY_OUT_DIR/__init__.py"

python -m grpc_tools.protoc \
  --python_out="$PY_OUT_DIR" \
  --grpc_python_out="$PY_OUT_DIR" \
  --proto_path="$PROTO_DIR" \
  "$PROTO_DIR"/*.proto

echo "Generated gRPC code for stt-service (Python)"
echo "Done."
