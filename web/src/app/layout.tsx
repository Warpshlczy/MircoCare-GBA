import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "忆伴 MemoMate",
  description: "零 UI 语音长者关怀助手（粤港澳大湾区）：食药提醒、跌倒守护、跨境健康卡。",
  manifest: "/manifest.webmanifest",
  applicationName: "MemoMate",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "忆伴" },
  formatDetection: { telephone: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#F4A259",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-HK">
      <body className="min-h-[100dvh] antialiased">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}",
          }}
        />
      </body>
    </html>
  );
}