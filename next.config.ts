import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // allowedDevOrigins hanya untuk development
  ...(process.env.NODE_ENV !== 'production' && {
    allowedDevOrigins: [
      'https://*.space-z.ai',
    ],
  }),
};

export default nextConfig;
