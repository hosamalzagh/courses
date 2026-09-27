import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Full prefetches live only in this browser session. Ordinary navigation
    // stays fresh; mutations use router.refresh() to invalidate prefetched data.
    staleTimes: { dynamic: 0, static: 30 },
  },
};

export default nextConfig;
