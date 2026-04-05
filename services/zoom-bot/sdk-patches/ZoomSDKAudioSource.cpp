#include "ZoomSDKAudioSource.h"
#include <iostream>
#include <chrono>
#include <cstring>
#include <sys/stat.h>

// Watch /tmp/zoom-audio/tts-output.pcm for new TTS audio
// When the file appears or changes, read it and send via the SDK

ZoomSDKAudioSource::ZoomSDKAudioSource()
    : m_sender(nullptr), m_canSend(false), m_running(false),
      m_ttsFilePath("/tmp/zoom-audio/tts-output.pcm") {}

ZoomSDKAudioSource::~ZoomSDKAudioSource() {
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

    // Start the file watcher thread
    m_sendThread = thread(&ZoomSDKAudioSource::sendLoop, this);
}

void ZoomSDKAudioSource::onMicStopSend() {
    cout << "⏹️ virtual mic stop send" << endl;
    m_canSend = false;
}

void ZoomSDKAudioSource::onMicUninitialized() {
    cout << "🔇 virtual mic uninitialized" << endl;
    m_running = false;
    m_canSend = false;
    m_sender = nullptr;
}

void ZoomSDKAudioSource::setTTSFilePath(const string& path) {
    m_ttsFilePath = path;
}

void ZoomSDKAudioSource::sendLoop() {
    size_t lastSize = 0;
    const int SAMPLE_RATE = 16000;
    // Send 20ms chunks: 16000 samples/sec * 2 bytes * 0.02s = 640 bytes
    const int CHUNK_SIZE = 640;
    const int CHUNK_INTERVAL_US = 20000; // 20ms in microseconds

    cout << "⏳ watching for TTS audio at " << m_ttsFilePath << endl;

    while (m_running) {
        if (!m_canSend || !m_sender) {
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
        if (fileSize <= lastSize || fileSize == 0) {
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

        char* buffer = new char[newBytes];
        file.read(buffer, newBytes);
        file.close();

        cout << "🔊 sending " << newBytes << " bytes of TTS audio to Zoom" << endl;

        // Send in 20ms chunks at real-time pace
        size_t offset = 0;
        while (offset < newBytes && m_canSend && m_sender) {
            size_t chunkLen = min((size_t)CHUNK_SIZE, newBytes - offset);
            // Ensure even length
            chunkLen = chunkLen & ~1;
            if (chunkLen == 0) break;

            auto err = m_sender->send(buffer + offset, chunkLen, SAMPLE_RATE,
                                       ZoomSDKAudioChannel_Mono);
            if (err != SDKERR_SUCCESS) {
                cerr << "❌ audio send error: " << err << endl;
                break;
            }

            offset += chunkLen;
            this_thread::sleep_for(chrono::microseconds(CHUNK_INTERVAL_US));
        }

        delete[] buffer;
        cout << "✅ TTS audio sent to Zoom" << endl;

        // Reset: truncate the file so we don't re-send
        ofstream clear(m_ttsFilePath, ios::trunc);
        clear.close();
        lastSize = 0;
    }
}
