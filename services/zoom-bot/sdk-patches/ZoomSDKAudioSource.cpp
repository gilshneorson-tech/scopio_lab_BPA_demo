#include "ZoomSDKAudioSource.h"
#include <iostream>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <vector>
#include <sys/stat.h>

// Watch /tmp/zoom-audio/tts-output.pcm for new TTS audio.
// When the file appears or changes, read it and send via the SDK.
//
// Interrupt protocol: the Node side writes /tmp/zoom-audio/tts-control.stop
// when the prospect interrupts. The send loop checks for that sentinel on
// every 20ms chunk, aborts playback, truncates the audio file, and removes
// the sentinel — so an interrupt cuts narration immediately instead of
// letting the rest of the utterance play out.

ZoomSDKAudioSource::ZoomSDKAudioSource()
    : m_sender(nullptr), m_canSend(false), m_running(false), m_threadStarted(false),
      m_ttsFilePath("/tmp/zoom-audio/tts-output.pcm"),
      m_stopFilePath("/tmp/zoom-audio/tts-control.stop") {}

ZoomSDKAudioSource::~ZoomSDKAudioSource() {
    m_canSend = false;
    m_running = false;
    if (m_sendThread.joinable())
        m_sendThread.join();
}

void ZoomSDKAudioSource::onMicInitialize(IZoomSDKAudioRawDataSender* pSender) {
    cout << "✅ virtual mic initialized" << endl;
    m_sender = pSender;
}

void ZoomSDKAudioSource::onMicStartSend() {
    cout << "✅ virtual mic can send" << endl;
    m_canSend = true;
    m_running = true;

    // This callback can fire again on mute/unmute or a VoIP reconnect.
    // Assigning to an already-joinable std::thread calls std::terminate()
    // and kills the whole SDK process mid-meeting — start it exactly once.
    bool expected = false;
    if (m_threadStarted.compare_exchange_strong(expected, true)) {
        m_sendThread = thread(&ZoomSDKAudioSource::sendLoop, this);
    }
}

void ZoomSDKAudioSource::onMicStopSend() {
    cout << "⏹️ virtual mic stop send" << endl;
    m_canSend = false;
}

void ZoomSDKAudioSource::onMicUninitialized() {
    cout << "🔇 virtual mic uninitialized" << endl;
    m_canSend = false;
    m_running = false;
    m_sender = nullptr;
}

void ZoomSDKAudioSource::setTTSFilePath(const string& path) {
    m_ttsFilePath = path;
}

bool ZoomSDKAudioSource::stopRequested() {
    struct stat st;
    return stat(m_stopFilePath.c_str(), &st) == 0;
}

void ZoomSDKAudioSource::truncateTTSFile() {
    ofstream clear(m_ttsFilePath, ios::trunc);
    clear.close();
}

void ZoomSDKAudioSource::sendLoop() {
    size_t lastSize = 0;
    const int SAMPLE_RATE = 16000;
    // Send 20ms chunks: 16000 samples/sec * 2 bytes * 0.02s = 640 bytes
    const int CHUNK_SIZE = 640;
    const int CHUNK_INTERVAL_US = 20000; // 20ms in microseconds

    cout << "⏳ watching for TTS audio at " << m_ttsFilePath << endl;

    while (m_running) {
        if (!m_canSend || m_sender.load() == nullptr) {
            this_thread::sleep_for(chrono::milliseconds(100));
            continue;
        }

        // Check if TTS file has new data
        struct stat st;
        if (stat(m_ttsFilePath.c_str(), &st) != 0) {
            this_thread::sleep_for(chrono::milliseconds(50));
            continue;
        }

        size_t fileSize = st.st_size;
        if (fileSize < lastSize) {
            // File was truncated externally (stop/cleanup) — resync so the
            // next utterance is not silently skipped
            lastSize = 0;
            this_thread::sleep_for(chrono::milliseconds(50));
            continue;
        }
        if (fileSize == lastSize || fileSize == 0) {
            this_thread::sleep_for(chrono::milliseconds(50));
            continue;
        }

        // New TTS audio available — read and send
        ifstream file(m_ttsFilePath, ios::binary);
        if (!file.is_open()) {
            this_thread::sleep_for(chrono::milliseconds(50));
            continue;
        }

        // Seek to where we left off
        file.seekg(lastSize);
        size_t newBytes = fileSize - lastSize;
        lastSize = fileSize;

        vector<char> buffer(newBytes);
        file.read(buffer.data(), newBytes);
        size_t gotBytes = (size_t)file.gcount();
        file.close();
        if (gotBytes == 0) continue;

        cout << "🔊 sending " << gotBytes << " bytes of TTS audio to Zoom" << endl;

        // Send in 20ms chunks at real-time pace
        bool stopped = false;
        size_t offset = 0;
        while (offset < gotBytes && m_canSend) {
            IZoomSDKAudioRawDataSender* sender = m_sender.load();
            if (!sender) break;

            if (stopRequested()) {
                cout << "🛑 stop requested — aborting TTS playback" << endl;
                stopped = true;
                break;
            }

            size_t chunkLen = min((size_t)CHUNK_SIZE, gotBytes - offset);
            // Ensure even length
            chunkLen = chunkLen & ~1;
            if (chunkLen == 0) break;

            auto err = sender->send(buffer.data() + offset, chunkLen, SAMPLE_RATE,
                                    ZoomSDKAudioChannel_Mono);
            if (err != SDKERR_SUCCESS) {
                cerr << "❌ audio send error: " << err << endl;
                break;
            }

            offset += chunkLen;
            this_thread::sleep_for(chrono::microseconds(CHUNK_INTERVAL_US));
        }

        if (stopped) {
            // Drop whatever is left of this (and any queued) utterance
            truncateTTSFile();
            remove(m_stopFilePath.c_str());
            lastSize = 0;
            cout << "🛑 TTS playback stopped and queue cleared" << endl;
            continue;
        }

        cout << "✅ TTS audio sent to Zoom" << endl;

        // Reset: truncate the file so we don't re-send
        truncateTTSFile();
        lastSize = 0;
    }
}
