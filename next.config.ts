import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the ngrok tunnel host to access dev resources (HMR, etc.).
  allowedDevOrigins: ["kind-intensely-herring.ngrok-free.app"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No other site may frame Pulse: a hidden iframe could trick someone
          // into clicking Accept, or into granting camera access.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Mapbox token URL restrictions rely on the origin being sent, so
          // not `no-referrer`.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Camera, mic and location for Pulse itself only, never an embed.
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
