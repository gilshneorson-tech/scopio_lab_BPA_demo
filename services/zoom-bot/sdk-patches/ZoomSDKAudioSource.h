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
    IZoomSDKAudioRawDataSender* m_sender;
    atomic<bool> m_canSend;
    atomic<bool> m_running;
    string m_ttsFilePath;
    thread m_sendThread;

    void sendLoop();
};

#endif
