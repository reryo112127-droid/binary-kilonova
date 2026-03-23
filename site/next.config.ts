import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // サーバーレス関数のバンドルに data/ ディレクトリを含める
  outputFileTracingIncludes: {
    '/api/actress/[name]': ['./data/**/*'],
    '/api/products':       ['./data/**/*'],
    '/api/suggest':        ['./data/**/*'],
    '/api/ranking':        ['./data/**/*'],
    '/':                   ['./public/design/**/*'],
    '/product/[id]':       ['./public/design/**/*'],
    '/ranking':            ['./public/design/**/*'],
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
