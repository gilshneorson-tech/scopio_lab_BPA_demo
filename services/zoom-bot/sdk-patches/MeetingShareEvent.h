#ifndef MEETING_SHARE_EVENT_H
#define MEETING_SHARE_EVENT_H

#include <iostream>
#include "meeting_service_components/meeting_sharing_interface.h"

using namespace std;
using namespace ZOOMSDK;

class MeetingShareEvent : public IMeetingShareCtrlEvent {
public:
    MeetingShareEvent() {}

    void onSharingStatus(ZoomSDKSharingSourceInfo shareInfo) override {
        auto status = shareInfo.status;
        if (status == Sharing_Self_Send_Begin)
            cout << "✅ screen share started" << endl;
        else if (status == Sharing_Self_Send_End)
            cout << "⏹️ screen share stopped" << endl;
    }

    void onFailedToStartShare() override {
        cout << "❌ failed to start screen share" << endl;
    }

    void onLockShareStatus(bool bLocked) override {}
    void onShareContentNotification(ZoomSDKSharingSourceInfo shareInfo) override {}
    void onMultiShareSwitchToSingleShareNeedConfirm(IShareSwitchMultiToSingleConfirmHandler* handler_) override {}
    void onShareSettingTypeChangedNotification(ShareSettingType type) override {}
    void onSharedVideoEnded() override {}
    void onVideoFileSharePlayError(ZoomSDKVideoFileSharePlayError error) override {}
    void onOptimizingShareForVideoClipStatusChanged(ZoomSDKSharingSourceInfo shareInfo) override {}
};

#endif
