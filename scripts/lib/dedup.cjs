/**
 * MGS動画 と FANZA videoc(素人) の重複判定ロジック（共有）。
 *
 * 同一作品が MGS と FANZA videoc 両方にある場合、MGS のほうがパッケージ画質が良いので
 * FANZA videoc 側を重複として除外する。判定は次の2条件をAND:
 *   1. 品番一致: MGS品番を変換した FANZA品番 == 対象の fanza_pid
 *      例) MGS "230OREC-134" → "orec134"
 *   2. タイトル一致: 女優ニックネーム等のコアが一致（採番ズレ系列(ENDX等)の誤マッチを除外）
 *
 * 使い方:
 *   const { toFanzaPid, isDuplicate } = require('./lib/dedup.cjs');
 *   // index: { fanzaPid: mgsTitle }  ← build_dedup_index.js が生成
 *   isDuplicate(fanzaPid, fanzaTitle, index) -> boolean
 */

// MGS品番 → FANZA品番  "230OREC-134" -> "orec134" / 変換不可なら null
function toFanzaPid(mgsPid) {
    const m = String(mgsPid).match(/^\d+([A-Z]+)-(\d+)$/);
    if (!m) return null;
    return m[1].toLowerCase() + String(parseInt(m[2], 10));
}

// タイトルから比較用コア（女優ニックネーム）を抽出
function nameCore(s) {
    return String(s || '')
        .replace(/【[^】]*】/g, '')
        .replace(/[(（][^)）]*[)）]/g, '')
        .replace(/さん|ちゃん|歳|代|第|本編|完全版|前編|後編/g, '')
        .replace(/[0-9０-９\s,、。!！?？.・]/g, '')
        .trim();
}

// 抽出済みコア同士が同一作品とみなせるか
function coreMatch(x, y) {
    if (!x || !y) return false;
    if (x === y) return true;
    const s = x.length <= y.length ? x : y;
    const l = x.length <= y.length ? y : x;
    if (s.length >= 2 && l.includes(s)) return true;
    if (s.length >= 3 && l.slice(0, s.length) === s) return true;
    return false;
}

// 2つのタイトル（生）が同一作品とみなせるか
function titleMatch(a, b) {
    return coreMatch(nameCore(a), nameCore(b));
}

/**
 * fanza_pid/title が MGS の重複か判定。
 * @param {string} fanzaPid
 * @param {string} fanzaTitle
 * @param {Record<string,string>} index  fanzaPid -> MGSタイトルのコア(nameCore済み)
 */
function isDuplicate(fanzaPid, fanzaTitle, index) {
    const mgsCore = index[fanzaPid];
    if (mgsCore === undefined) return false;
    return coreMatch(nameCore(fanzaTitle), mgsCore);
}

module.exports = { toFanzaPid, nameCore, coreMatch, titleMatch, isDuplicate };
