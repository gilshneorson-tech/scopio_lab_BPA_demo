FROM python:3.12-slim

WORKDIR /app

COPY services/stt-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY proto/ ./proto/
COPY services/stt-service/src/ ./src/

# Generate gRPC stubs at build time (server.py skips generation when present)
RUN mkdir -p /app/src/generated && touch /app/src/generated/__init__.py && \
    python -m grpc_tools.protoc \
      --proto_path=/app/proto \
      --python_out=/app/src/generated \
      --grpc_python_out=/app/src/generated \
      /app/proto/stt.proto

EXPOSE 50056
CMD ["python", "src/server.py"]
