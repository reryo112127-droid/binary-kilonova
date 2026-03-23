/**
 * SNS投稿文モジュール — フォールバックフレーズをそのまま返す
 */

async function rewritePhrase(personaKey, fallback, hint = {}) {
    return fallback;
}

module.exports = { rewritePhrase };
