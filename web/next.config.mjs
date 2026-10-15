/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export → `out/`, which is both the PWA deployable AND the webDir the
  // Android shell (Capacitor) loads. This app is 100% client-side, so nothing
  // server-only is lost.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;