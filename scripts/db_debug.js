// sql.js DB debug - check actual count and export size
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'mgs.db');

async function main() {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(DB_PATH);
    console.log(`DB file size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

    const db = new SQL.Database(buffer);

    const result = db.exec('SELECT COUNT(*) FROM products');
    console.log('Count in loaded DB:', result[0].values[0][0]);

    const first = db.exec('SELECT product_id FROM products ORDER BY rowid ASC LIMIT 3');
    console.log('First 3:', first[0].values.map(v => v[0]));

    const last = db.exec('SELECT product_id FROM products ORDER BY rowid DESC LIMIT 3');
    console.log('Last 3:', last[0].values.map(v => v[0]));

    const exported = db.export();
    console.log(`Export type: ${exported.constructor.name}, length: ${exported.length}, MB: ${(exported.length / 1024 / 1024).toFixed(2)}`);

    db.close();
}

main().catch(console.error);
