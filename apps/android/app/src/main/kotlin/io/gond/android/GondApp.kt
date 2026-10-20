package io.gond.android

import android.app.Application

class GondApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannel(this)
    }
}
