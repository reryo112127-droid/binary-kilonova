import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  // サーバーレス関数のバンドルに必要なファイルのみ含める
  // 女優プロフィールはTursoに移行済みのためファイルバンドル不要
  outputFileTracingIncludes: {
    '/':             ['./public/design/**/*', './data/*_cache.json'],
    '/product/[id]': ['./public/design/**/*'],
    '/ranking':        ['./public/design/**/*'],
    '/ranking/custom': ['./public/design/**/*'],
    '/ranking/actress':['./public/design/**/*'],
    '/new':          ['./public/design/**/*'],
    '/pre-order':    ['./public/design/**/*'],
    '/products':     ['./public/design/**/*'],
    '/search':       ['./public/design/**/*'],
    '/actress/[name]': ['./public/design/**/*'],
    '/review/add/[id]': ['./public/design/**/*'],
    '/api/products':          ['./data/*_cache.json'],
    '/api/ranking':           ['./data/*_cache.json'],
    '/api/ranking/actress':   ['./data/*_cache.json'],
    '/api/search-options':    ['./data/suggest_cache.json'],
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
