/**
 * FANZAカタログのシャーディング用ハッシュ。
 * 無料D1(500MB/DB)に収めるため FANZA products を product_id のハッシュで N分割する。
 *
 * - 書き込み(日次スクリプト): shardOf(product_id) でどのシャードに書くか決定。
 * - 読み取り(ランタイム): 全シャードに同じSELECTを投げて結果をマージ（ハッシュ不要）。
 *
 * export と日次スクリプトで同一のハッシュを使うこと（このファイルを共有）。
 */
const FANZA_SHARDS = 2;

function shardOf(productId, n = FANZA_SHARDS) {
    const s = String(productId);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
    return h % n;
}

module.exports = { FANZA_SHARDS, shardOf };
