const fs = require('fs');
const initSqlJs = require('sql.js');

const actressesData = JSON.parse(fs.readFileSync('data/actresses_all.json', 'utf-8'));
console.log('Actress JSON sample:', actressesData.slice(0, 2));

async function main() {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync('data/mgs.db'));
    
    const res = db.exec("PRAGMA table_info(products)");
    if(res.length > 0) {
        console.log('products columns:', res[0].values.map(c => c[1]));
    }

    const actorsInfo = db.exec("PRAGMA table_info(actresses)");
    if(actorsInfo.length > 0) {
         console.log('actresses columns:', actorsInfo[0].values.map(c => c[1]));
         const sampleActors = db.exec("SELECT * FROM actresses LIMIT 1");
         console.log('actresses sample:', sampleActors[0].values[0]);
    } else {
         console.log('No actresses table found.');
    }
}
main().catch(console.error);
