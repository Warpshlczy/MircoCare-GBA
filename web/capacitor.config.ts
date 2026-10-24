import type { CapacitorConfig } from "@capacitor/cli";

// Android shell for MemoMate. `webDir` is the static Next export (`next build`
// with output: 'export' → ./out). See DEV.md §"Android 原生版本" for the build.
const config: CapacitorConfig = {
  appId: "com.auragba.app",
  appName: "忆伴",
  webDir: "out",
  android: {
    // All app traffic is same-origin local assets; no cleartext needed.
    allowMixedContent: false,
  },
  server: {
    // WebView runs on an https origin so mic/camera/service-worker APIs behave
    // like the web build.
    // 真机联调：CAP_ANDROID_SCHEME=http 时起源变为 http://localhost，配合
    // `adb reverse tcp:8000 tcp:8000` 才能用 HttpOnly Cookie 直连本机后端；
    // 默认仍为 https，避免发布包降级。
    androidScheme: process.env.CAP_ANDROID_SCHEME === "http" ? "http" : "https",
  },
};

export default config;