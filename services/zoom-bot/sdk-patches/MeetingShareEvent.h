#ifndef MEETING_SHARE_EVENT_H
#define MEETING_SHARE_EVENT_H

#include <iostream>
#include "meeting_service_components/meeting_sharing_interface.h"
#include "util/Log.h"

using namespace std;
using namespace ZOOMSDK;

class MeetingShareEvent : public IMeetingShareCtrlEvent {
public:
    MeetingShareEvent() {}

    void onSharingStatus(SharingStatus status, unsigned int userId) override {
        switch (status) {
            case Sharing_Self_Send_Begin:
                Log::success("screen share started");
                break;
            case Sharing_Self_Send_End:
                Log::info("screen share stopped");
                break;
            default:
                break;
        }
    }

    void onLockShareStatus(bool locked) override {
        if (locked) Log::info("share locked by host");
    }

    void onShareContentNotification(ShareInfo& shareInfo) override {}
    void onMultiShareSwitchToSingleShareNeedConfirm(IShareSwitchMultiToSingleConfirmHandler* handler) override {}
    void onShareSettingTypeChangedNotification(ShareSettingType type) override {}
    void onSharedVideoEnded() override {}
};

#endif
