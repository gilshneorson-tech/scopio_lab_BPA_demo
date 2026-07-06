"""
STT Service — Google Cloud Speech-to-Text streaming via gRPC.

Receives audio chunks from zoom-bot via bidirectional gRPC stream,
forwards to Google Cloud STT streaming API, and returns transcriptions.

Google hard-caps a single streaming_recognize stream at ~5 minutes, but a
demo call runs 10+. The handler therefore rotates the upstream Google stream
(proactively before the limit, and reactively on transient errors) while
keeping the client-facing gRPC stream open — the caller never notices.
"""

import logging
import os
import sys
import time
import subprocess
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
# latest_short returns is_final much faster after end-of-speech than
# latest_long — this is a conversational voice agent, not long-form dictation
STT_MODEL = os.environ.get("STT_MODEL", "latest_short")

# Rotate the Google stream well before its ~305s hard limit
STREAM_ROTATE_SECONDS = int(os.environ.get("STT_STREAM_ROTATE_SECONDS", "240"))

# ─── Proto generation at startup ───

# Try local dev path first, then Docker container path
_dev_proto = Path(__file__).resolve().parent.parent.parent.parent / "proto"
_docker_proto = Path("/app/proto")
PROTO_DIR = _dev_proto if _dev_proto.exists() else _docker_proto
GENERATED_DIR = Path(__file__).resolve().parent / "generated"


def generate_protos():
    """Generate gRPC Python stubs from .proto files (skip if already present,
    e.g. generated at Docker build time)."""
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    init_file = GENERATED_DIR / "__init__.py"
    if not init_file.exists():
        init_file.touch()

    if (GENERATED_DIR / "stt_pb2.py").exists() and (GENERATED_DIR / "stt_pb2_grpc.py").exists():
        logger.info("Proto stubs already present — skipping generation")
        return

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

    def __init__(self):
        # One client for the process — channel/auth setup is not paid per call
        self._client = speech.SpeechClient()

    def StreamAudio(self, request_iterator, context):
        """
        Synchronous bidirectional streaming handler.
        Receives AudioChunk messages, streams to Google Cloud STT,
        yields Transcription messages. Transparently reopens the Google
        stream on its ~5-minute limit and on transient errors.
        """
        chunks = iter(request_iterator)

        # Peek the first chunk for call_id and the actual sample rate —
        # hardcoding 32kHz decoded 16kHz test audio at double speed.
        try:
            first_chunk = next(chunks)
        except StopIteration:
            return

        call_id = first_chunk.call_id or ""
        sample_rate = first_chunk.sample_rate or 32000

        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            language_code=STT_LANGUAGE,
            enable_automatic_punctuation=True,
            model=STT_MODEL,
        )
        streaming_config = speech.StreamingRecognitionConfig(
            config=config,
            interim_results=True,
            single_utterance=False,
        )

        logger.info(
            f"[{call_id}] STT stream opened (sample_rate={sample_rate}, model={STT_MODEL})"
        )

        pending = [first_chunk]
        client_stream_done = False

        def audio_generator(window_start):
            """Feed Google from the shared chunk iterator. Returns (ending the
            Google stream cleanly) when the rotation window expires; the outer
            loop then opens a fresh Google stream on the same iterator."""
            nonlocal client_stream_done
            while pending:
                c = pending.pop(0)
                if c.audio_data:
                    yield speech.StreamingRecognizeRequest(audio_content=bytes(c.audio_data))
            for chunk in chunks:
                if chunk.audio_data:
                    yield speech.StreamingRecognizeRequest(audio_content=bytes(chunk.audio_data))
                if time.time() - window_start > STREAM_ROTATE_SECONDS:
                    logger.info(f"[{call_id}] Rotating Google STT stream before the 5-min limit")
                    return
            client_stream_done = True

        while not client_stream_done and context.is_active():
            window_start = time.time()
            try:
                responses = self._client.streaming_recognize(
                    config=streaming_config,
                    requests=audio_generator(window_start),
                )

                for response in responses:
                    # A single response can carry a final result AND the
                    # interim of the next utterance — process all of them
                    for result in response.results:
                        if not result.alternatives:
                            continue
                        alternative = result.alternatives[0]

                        t_now = time.time()
                        transcription = stt_pb2.Transcription(
                            call_id=call_id,
                            text=alternative.transcript,
                            is_final=result.is_final,
                            confidence=alternative.confidence if result.is_final else 0.0,
                            timestamp_ms=int(t_now * 1000),
                        )

                        if result.is_final:
                            logger.info(
                                f"[{call_id}] Final: \"{alternative.transcript}\" "
                                f"(confidence={alternative.confidence:.2f})"
                            )
                        else:
                            logger.debug(
                                f"[{call_id}] Interim: \"{alternative.transcript}\""
                            )

                        yield transcription

            except Exception as e:  # noqa: BLE001 — any Google-side error is survivable
                if not context.is_active():
                    logger.info(f"[{call_id}] Client stream closed — stopping")
                    return
                # A transient Google error must not kill transcription for the
                # rest of the call — reopen and keep going.
                logger.warning(f"[{call_id}] Google STT stream error — reconnecting: {e}")
                time.sleep(0.2)
                continue

        logger.info(f"[{call_id}] STT stream ended")


# ─── Server ───

def serve():
    """Start the gRPC server."""
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    stt_pb2_grpc.add_STTServicer_to_server(STTServicer(), server)

    addr = f"0.0.0.0:{GRPC_PORT}"
    server.add_insecure_port(addr)
    server.start()

    logger.info(f"STT service listening on {addr}")
    logger.info(f"Language: {STT_LANGUAGE}, model: {STT_MODEL}, GCP project: {GCP_PROJECT}")

    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        logger.info("STT service shutting down")
        server.stop(grace=5)


if __name__ == "__main__":
    serve()
