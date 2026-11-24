# Android app

Read with the root `CLAUDE.md`, whose rules (Bun only, copy, tests, before a
commit, things that stay true) hold here too.

- `apps/android`: Kotlin, Gradle, one activity, a WebView. Connect is
  native (`res/values*/colors.xml` carry the tokens). The bridge is
  `gondMobile` (`GondBridge.kt`); keep it that small, and every action
  goes through `fromTrustedPage`. `RECORD_AUDIO` is granted in
  `onPermissionRequest` only to the saved origin and only on its own.
  `ServerUrl.kt` mirrors `server-url`. Edge to edge: your Gond's pages
  draw under the bars and get their sizes as `--shell-inset-*`
  (`layoutFor`/`pushInsets` in `MainActivity.kt`; only the keyboard pads
  the window), while Connect and other origins stay between the bars.
  Build with `gradle assembleRelease` in `apps/android` (ANDROID_HOME
  set); CI does, signed with the release key in its secrets.
  Push: `PushService` takes Firebase's messages and opens each with the
  phone's seal key (`PushCrypto`, the keys wrapped by `Vault`). A card's
  notice has Approve and Deny (`AnswerReceiver`, the phone unlocked
  first), posting `/api/push/answer` signed with the answer key.
  `google-services.json` comes from CI's `GOOGLE_SERVICES_JSON` and is
  never checked in; a build without it has no push. The page signs the
  phone up (`syncPhonePush`) through `pushState` and `setPushDevice`
  (`GondPush`, kept off `GondMobile` so an older app needn't offer it), as
  in the iPhone app.
  A call keeps going in the background through `CallService`, a
  microphone foreground service with an "On a call with …" notice (End
  there is `gond:call-end`), started by `setCall` (`GondCall`, off
  `GondMobile` too) once the page's mic runs, since Android refuses it
  otherwise.
