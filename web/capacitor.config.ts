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
    androidScheme: "https",
  },
};

export default config;