const fs = require('fs');
const initSqlJs = require('sql.js');
async function main() {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync('data/mgs.db'));
    const r1 = db.exec("SELECT product_id, title FROM products WHERE maker LIKE '%パラダイステレビ%' AND actresses IS NULL LIMIT 2;");
    if(r1.length) console.log('パラダイステレビ:', r1[0].values);
    const r2 = db.exec("SELECT product_id, title FROM products WHERE maker LIKE '%俺の素人%' AND actresses IS NULL LIMIT 2;");
    if(r2.length) console.log('俺の素人:', r2[0].values);
}
main();
