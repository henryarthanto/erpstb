import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: [
    'https://preview-chat-d8fe72eb-eaf2-4af7-835f-48f21c6857a6.space-z.ai',
    'https://*.space-z.ai',
  ],
};

export default nextConfig;
