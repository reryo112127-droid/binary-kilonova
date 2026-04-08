/**
 * data/*.json の静的キャッシュファイルを読み込むユーティリティ。
 * ファイルが存在しない場合は null を返す（Tursoフォールバック用）。
 */
import fs from 'fs';
import path from 'path';

const _mem = new Map<string, unknown>();

export function readStaticCache<T>(filename: string): T | null {
    if (_mem.has(filename)) return _mem.get(filename) as T;
    try {
        const p = path.join(process.cwd(), 'data', filename);
        const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
        _mem.set(filename, data);
        return data;
    } catch {
        return null;
    }
}
