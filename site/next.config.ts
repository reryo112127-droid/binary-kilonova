import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // サーバーレス関数のバンドルに必要なファイルのみ含める
  outputFileTracingIncludes: {
    '/api/actress/[name]': [
      './data/actress_profiles.json',
      './data/avwiki_profiles.json',
      './data/agency_profiles.json',
      './data/actress_aliases.json',
      './data/augmented_actresses.json',
    ],
    '/api/products': [
      './data/actress_aliases.json',
    ],
    '/api/suggest': [
      './data/suggest_cache.json',
    ],
    '/api/ranking': [
      './data/suggest_cache.json',
    ],
    '/':             ['./public/design/**/*'],
    '/product/[id]': ['./public/design/**/*'],
    '/ranking':      ['./public/design/**/*'],
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
