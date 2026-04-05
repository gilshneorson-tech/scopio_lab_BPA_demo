#ifndef MEETING_SHARE_EVENT_H
#define MEETING_SHARE_EVENT_H

#include <iostream>
#include "meeting_service_components/meeting_sharing_interface.h"

using namespace std;
using namespace ZOOMSDK;

class MeetingShareEvent : public IMeetingShareCtrlEvent {
public:
    MeetingShareEvent() {}

    void onSharingStatus(SharingStatus status, unsigned int userId) override {
        switch (status) {
            case Sharing_Self_Send_Begin:
                cout << "✅ screen share started" << endl;
                break;
            case Sharing_Self_Send_End:
                cout << "⏹️ screen share stopped" << endl;
                break;
            default:
                break;
        }
    }

    void onLockShareStatus(bool locked) override {}
    void onShareContentNotification(ShareInfo& shareInfo) override {}
    void onMultiShareSwitchToSingleShareNeedConfirm(IShareSwitchMultiToSingleConfirmHandler* handler) override {}
    void onShareSettingTypeChangedNotification(ShareSettingType type) override {}
    void onSharedVideoEnded() override {}
};

#endif
