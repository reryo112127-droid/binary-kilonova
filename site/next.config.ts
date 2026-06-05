import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      // MGStage
      { protocol: 'https', hostname: 'image.mgstage.com' },
      { protocol: 'https', hostname: 'img.mgstage.com' },
      // FANZA / DMM
      { protocol: 'https', hostname: 'pics.dmm.co.jp' },
      { protocol: 'https', hostname: 'ec.dmm.com' },
      { protocol: 'https', hostname: 'cc3001.dmm.com' },
      { protocol: 'https', hostname: 'p.dmm.co.jp' },
      { protocol: 'https', hostname: '*.dmm.co.jp' },
      { protocol: 'https', hostname: '*.dmm.com' },
    ],
  },
};

export default nextConfig;
