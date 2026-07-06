#ifndef ZOOM_SDK_AUDIO_SOURCE_H
#define ZOOM_SDK_AUDIO_SOURCE_H

#include <string>
#include <thread>
#include <atomic>
#include <fstream>
#include "zoom_sdk_raw_data_def.h"
#include "rawdata/rawdata_audio_helper_interface.h"

using namespace std;
using namespace ZOOMSDK;

class ZoomSDKAudioSource : public IZoomSDKVirtualAudioMicEvent {
public:
    ZoomSDKAudioSource();
    ~ZoomSDKAudioSource();

    // IZoomSDKVirtualAudioMicEvent interface
    void onMicInitialize(IZoomSDKAudioRawDataSender* pSender) override;
    void onMicStartSend() override;
    void onMicStopSend() override;
    void onMicUninitialized() override;

    // Set the file to monitor for TTS audio
    void setTTSFilePath(const string& path);

private:
    // atomic: onMicUninitialized (SDK thread) nulls this while sendLoop
    // (our thread) is reading it — a plain pointer is a use-after-free race
    atomic<IZoomSDKAudioRawDataSender*> m_sender;
    atomic<bool> m_canSend;
    atomic<bool> m_running;
    atomic<bool> m_threadStarted;
    string m_ttsFilePath;
    string m_stopFilePath;
    thread m_sendThread;

    void sendLoop();
    bool stopRequested();
    void truncateTTSFile();
};

#endif
