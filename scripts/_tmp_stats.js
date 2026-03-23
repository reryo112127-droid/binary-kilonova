const fs = require('fs');
const initSqlJs = require('sql.js');

async function main() {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync('data/mgs.db'));

    const res1 = db.exec("SELECT COUNT(1) FROM products WHERE actresses IS NULL OR actresses = ''");
    console.log('完全に出演者不明(NULL/空)件数:', res1.length > 0 ? res1[0].values[0][0] : 0);

    const res2 = db.exec("SELECT COUNT(1) FROM products WHERE actresses LIKE '%素人%' OR actresses LIKE '%匿名%'");
    console.log('まだ素人や匿名が含まれる件数:', res2.length > 0 ? res2[0].values[0][0] : 0);

    db.close();
}

main().catch(console.error);
