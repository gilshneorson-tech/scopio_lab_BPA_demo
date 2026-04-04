"""
STT Service — Google Cloud Speech-to-Text streaming via gRPC.

Receives audio chunks from zoom-bot via bidirectional gRPC stream,
forwards to Google Cloud STT streaming API, and returns transcriptions.
"""

import asyncio
import logging
import os
import sys
import time
import subprocess
import importlib
from concurrent import futures
from pathlib import Path

import grpc
from google.cloud import speech

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

GRPC_PORT = os.environ.get("GRPC_PORT", "50056")
STT_LANGUAGE = os.environ.get("STT_LANGUAGE", "en-US")
GCP_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "scopio-lab-bpa-demo")

# ─── Proto generation at startup ───

# Try local dev path first, then Docker container path
_dev_proto = Path(__file__).resolve().parent.parent.parent.parent / "proto"
_docker_proto = Path("/app/proto")
PROTO_DIR = _dev_proto if _dev_proto.exists() else _docker_proto
GENERATED_DIR = Path(__file__).resolve().parent / "generated"


def generate_protos():
    """Generate gRPC Python stubs from .proto files."""
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    init_file = GENERATED_DIR / "__init__.py"
    if not init_file.exists():
        init_file.touch()

    stt_proto = PROTO_DIR / "stt.proto"
    if not stt_proto.exists():
        logger.error(f"Proto file not found: {stt_proto}")
        sys.exit(1)

    logger.info(f"Generating proto stubs from {stt_proto}")
    subprocess.run(
        [
            sys.executable, "-m", "grpc_tools.protoc",
            f"--proto_path={PROTO_DIR}",
            f"--python_out={GENERATED_DIR}",
            f"--grpc_python_out={GENERATED_DIR}",
            str(stt_proto),
        ],
        check=True,
    )
    logger.info("Proto stubs generated successfully")


generate_protos()

# Import generated stubs — add generated dir to path so stt_pb2_grpc can find stt_pb2
sys.path.insert(0, str(GENERATED_DIR))
import stt_pb2, stt_pb2_grpc  # noqa: E402


# ─── STT Servicer ───

class STTServicer(stt_pb2_grpc.STTServicer):
    """Bidirectional streaming: receive audio chunks, yield transcriptions."""

    def StreamAudio(self, request_iterator, context):
        """
        Synchronous bidirectional streaming handler.
        Receives AudioChunk messages, streams to Google Cloud STT,
        yields Transcription messages.
        """
        client = speech.SpeechClient()
        call_id = None

        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=16000,
            language_code=STT_LANGUAGE,
            enable_automatic_punctuation=True,
            model="latest_long",
        )

        streaming_config = speech.StreamingRecognitionConfig(
            config=config,
            interim_results=True,
            single_utterance=False,
        )

        def audio_generator():
            """Convert gRPC request stream to Google STT audio requests."""
            nonlocal call_id

            for chunk in request_iterator:
                if not call_id:
                    call_id = chunk.call_id
                if chunk.audio_data:
                    yield speech.StreamingRecognizeRequest(
                        audio_content=bytes(chunk.audio_data)
                    )

        try:
            t_start = time.time()
            responses = client.streaming_recognize(
                config=streaming_config,
                requests=audio_generator(),
            )

            for response in responses:
                if not response.results:
                    continue

                result = response.results[0]
                alternative = result.alternatives[0]

                t_now = time.time()
                latency_ms = int((t_now - t_start) * 1000)

                transcription = stt_pb2.Transcription(
                    call_id=call_id or "",
                    text=alternative.transcript,
                    is_final=result.is_final,
                    confidence=alternative.confidence if result.is_final else 0.0,
                    timestamp_ms=int(t_now * 1000),
                )

                if result.is_final:
                    logger.info(
                        f"[{call_id}] Final: \"{alternative.transcript}\" "
                        f"(confidence={alternative.confidence:.2f}, latency={latency_ms}ms)"
                    )
                    t_start = time.time()  # Reset for next utterance
                else:
                    logger.debug(
                        f"[{call_id}] Interim: \"{alternative.transcript}\""
                    )

                yield transcription

        except Exception as e:
            logger.error(f"STT streaming error: {e}")
            context.abort(grpc.StatusCode.INTERNAL, str(e))


# ─── Server ───

def serve():
    """Start the gRPC server."""
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    stt_pb2_grpc.add_STTServicer_to_server(STTServicer(), server)

    addr = f"0.0.0.0:{GRPC_PORT}"
    server.add_insecure_port(addr)
    server.start()

    logger.info(f"STT service listening on {addr}")
    logger.info(f"Language: {STT_LANGUAGE}, GCP project: {GCP_PROJECT}")

    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        logger.info("STT service shutting down")
        server.stop(grace=5)


if __name__ == "__main__":
    serve()
