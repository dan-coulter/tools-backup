import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // Dev server is opened from other machines on the LAN.
  allowedDevOrigins: ["plex.local", "plex"],
};

export default nextConfig;
